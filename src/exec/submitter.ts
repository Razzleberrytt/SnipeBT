import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Connection, Commitment } from '@solana/web3.js';

import { getConfig } from '../config';
import { insertTrade } from '../db';
import {
  recordTradeConfirmation,
  recordTradeFailure,
  recordTradeSubmission,
  setRpcErrorRate
} from '../observability/metrics';

type OutcomeStatus = 'success' | 'failed' | 'dry-run';

export interface ExecutionIntent {
  mint: string;
  side: 'BUY' | 'SELL';
  transaction: string; // Base64-encoded transaction
  nonce: string;
  route?: string;
  expectedOutAmount?: number;
  dryRun?: boolean;
}

export interface SubmitOptions {
  maxRetries?: number;
  commitment?: Commitment;
}

export interface SubmitResult {
  idempotencyKey: string;
  signature?: string;
  confirmed: boolean;
  attempts: number;
  status: OutcomeStatus;
}

export class SubmitterError extends Error {
  constructor(public readonly code: string, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SubmitterError';
  }
}

interface SubmitterConfig {
  maxRetries: number;
  initialBackoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  failoverThreshold: number;
  breakerThreshold: number;
  commitment: Commitment;
}

const DEFAULT_SUBMITTER_CONFIG: SubmitterConfig = {
  maxRetries: 3,
  initialBackoffMs: 750,
  backoffMultiplier: 2,
  maxBackoffMs: 8000,
  failoverThreshold: 3,
  breakerThreshold: 5,
  commitment: 'confirmed'
};

const computeIdempotencyKey = (intent: ExecutionIntent): string => {
  return createHash('sha256').update(`${intent.mint}:${intent.side}:${intent.nonce}`).digest('hex');
};

interface EndpointState {
  url: string;
  connection: Connection;
  failures: number;
}

export class TransactionSubmitter extends EventEmitter {
  private readonly config = getConfig();
  private readonly submitterConfig: SubmitterConfig;
  private readonly endpoints: EndpointState[];
  private activeIndex = 0;
  private readonly cache = new Map<string, SubmitResult>();
  private consecutiveFailures = 0;
  private breakerOpen = false;
  private totalAttempts = 0;
  private totalFailures = 0;

  constructor(options: Partial<SubmitterConfig> = {}) {
    super();
    this.submitterConfig = { ...DEFAULT_SUBMITTER_CONFIG, ...options };
    const endpoints = [this.config.rpc.primary, ...this.config.rpc.backups];
    this.endpoints = endpoints.map((url) => ({
      url,
      connection: new Connection(url, { commitment: this.submitterConfig.commitment }),
      failures: 0
    }));
  }

  public isCircuitOpen(): boolean {
    return this.breakerOpen;
  }

  public resetCircuit(): void {
    this.breakerOpen = false;
    this.consecutiveFailures = 0;
    this.endpoints.forEach((endpoint) => {
      endpoint.failures = 0;
    });
  }

  private getActiveEndpoint(): EndpointState {
    return this.endpoints[this.activeIndex];
  }

  private rotateEndpoint(): void {
    this.activeIndex = (this.activeIndex + 1) % this.endpoints.length;
  }

  private recordAttempt(intent: ExecutionIntent, attempt: number, status: OutcomeStatus, signature?: string): void {
    insertTrade({
      symbol: intent.mint,
      side: intent.side,
      route: [intent.route, `attempt ${attempt}`].filter(Boolean).join(' | '),
      txSig: signature ?? null,
      status,
      createdAt: Date.now()
    });
  }

  private handleFailure(): void {
    const endpoint = this.getActiveEndpoint();
    endpoint.failures += 1;
    this.consecutiveFailures += 1;

    if (endpoint.failures >= this.submitterConfig.failoverThreshold) {
      this.rotateEndpoint();
    }

    if (this.consecutiveFailures >= this.submitterConfig.breakerThreshold) {
      this.breakerOpen = true;
      this.emit('circuit_open', {
        endpoint: endpoint.url,
        failures: this.consecutiveFailures
      });
    }

    const errorRate = this.totalAttempts === 0 ? 0 : this.totalFailures / this.totalAttempts;
    if (this.totalAttempts >= 5 && errorRate >= 0.5) {
      this.emit('high_failure_rate', {
        errorRate,
        attempts: this.totalAttempts,
        failures: this.totalFailures
      });
    }
  }

  private handleSuccess(): void {
    this.consecutiveFailures = 0;
    this.breakerOpen = false;
    this.endpoints.forEach((endpoint) => {
      endpoint.failures = 0;
    });
  }

  public async submit(intent: ExecutionIntent, options: SubmitOptions = {}): Promise<SubmitResult> {
    const idempotencyKey = computeIdempotencyKey(intent);
    if (this.cache.has(idempotencyKey)) {
      return this.cache.get(idempotencyKey)!;
    }

    if (intent.dryRun) {
      this.recordAttempt(intent, 0, 'dry-run');
      const dryResult: SubmitResult = {
        idempotencyKey,
        confirmed: false,
        attempts: 0,
        status: 'dry-run'
      };
      this.cache.set(idempotencyKey, dryResult);
      return dryResult;
    }

    if (this.breakerOpen) {
      throw new SubmitterError('CircuitOpen', 'Circuit breaker is active. Aborting transaction submission.');
    }

    const maxRetries = options.maxRetries ?? this.submitterConfig.maxRetries;
    const commitment = options.commitment ?? this.submitterConfig.commitment;

    recordTradeSubmission();

    let attempt = 0;
    let backoff = this.submitterConfig.initialBackoffMs;
    let lastError: unknown;

    while (attempt <= maxRetries) {
      attempt += 1;
      try {
        this.totalAttempts += 1;
        const endpoint = this.getActiveEndpoint();
        const rawTransaction = Buffer.from(intent.transaction, 'base64');
        const startedAt = Date.now();
        const signature = await endpoint.connection.sendRawTransaction(rawTransaction, {
          skipPreflight: false,
          preflightCommitment: commitment
        });

        const confirmation = await endpoint.connection.confirmTransaction(signature, commitment);
        if (confirmation.value.err) {
          throw new SubmitterError('TransactionError', 'Transaction failed confirmation', confirmation.value.err);
        }

        this.handleSuccess();
        this.recordAttempt(intent, attempt, 'success', signature);
        const latency = Date.now() - startedAt;
        recordTradeConfirmation(latency);
        setRpcErrorRate(this.totalAttempts === 0 ? 0 : this.totalFailures / this.totalAttempts);

        const result: SubmitResult = {
          idempotencyKey,
          signature,
          confirmed: true,
          attempts: attempt,
          status: 'success'
        };
        this.cache.set(idempotencyKey, result);
        return result;
      } catch (error) {
        lastError = error;
        this.handleFailure();
        this.totalFailures += 1;
        this.recordAttempt(intent, attempt, 'failed');
        setRpcErrorRate(this.totalAttempts === 0 ? 0 : this.totalFailures / this.totalAttempts);

        if (attempt > maxRetries) {
          break;
        }

        const jitter = Math.random() * 250;
        await delay(Math.min(backoff + jitter, this.submitterConfig.maxBackoffMs));
        backoff = Math.min(backoff * this.submitterConfig.backoffMultiplier, this.submitterConfig.maxBackoffMs);
      }
    }

    recordTradeFailure();
    throw new SubmitterError('SubmissionFailed', 'Failed to submit transaction after retries', lastError);
  }
}
