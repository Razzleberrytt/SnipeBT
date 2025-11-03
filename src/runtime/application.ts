import http from 'node:http';

import { AppConfig } from '../config';
import { withDb } from '../db';
import { TransactionSubmitter } from '../exec/submitter';
import logger from '../lib/logger';
import { setEquityEstimate, setOpenPositions, setRpcErrorRate, startMetricsServer } from '../observability/metrics';
import { runHealthChecks } from '../observability/health';
import { initializeTelegramOps, TelegramOpsConsole } from '../ops/telegram';
import { pauseLiveTrading, resumeLiveTrading } from '../state/runtime';

import { describeRuntimeMode, RuntimeSettings } from './modes';

const HEALTH_CHECK_INTERVAL_MS = 60_000;

const getOpenPositionCount = (): number => {
  return withDb((db) => {
    const row = db.prepare("SELECT COUNT(1) as count FROM positions WHERE status = 'open'").get() as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  });
};

export interface RuntimeContext {
  config: AppConfig;
  settings: RuntimeSettings;
  submitter: TransactionSubmitter;
}

export class ApplicationRuntime {
  private readonly submitter: TransactionSubmitter;
  private metricsServer: http.Server | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private telegram: TelegramOpsConsole | null = null;
  private started = false;

  constructor(private readonly config: AppConfig, private readonly settings: RuntimeSettings) {
    this.submitter = new TransactionSubmitter();
  }

  public getContext(): RuntimeContext {
    return {
      config: this.config,
      settings: this.settings,
      submitter: this.submitter
    };
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    logger.info(
      {
        mode: describeRuntimeMode(this.settings),
        dryRun: this.settings.dryRun,
        liveTrading: this.settings.liveTrading
      },
      'Starting application runtime'
    );

    if (this.settings.liveTrading) {
      resumeLiveTrading();
    } else {
      pauseLiveTrading();
    }

    this.metricsServer = startMetricsServer(this.config.metrics.port);
    setEquityEstimate(0);
    setOpenPositions(getOpenPositionCount());
    setRpcErrorRate(0);

    await this.runHealthChecks();
    this.healthTimer = setInterval(() => {
      this.runHealthChecks().catch((error) => {
        logger.error({ err: error }, 'Recurring health check failed');
      });
    }, HEALTH_CHECK_INTERVAL_MS);

    if (this.config.telegram.enabled) {
      this.telegram = initializeTelegramOps({
        submitter: this.submitter,
        getEquityEstimate: async () => 0,
        getOpenPositions: async () => getOpenPositionCount(),
        pauseTrading: () => {
          pauseLiveTrading();
        },
        resumeTrading: () => {
          if (this.settings.liveTrading) {
            resumeLiveTrading();
          } else {
            logger.warn('Resume command ignored: runtime not in live mode');
          }
        },
        liquidateAll: async () => {
          logger.warn('Liquidate-all command not implemented yet.');
        }
      });
    }

    this.started = true;
  }

  private async runHealthChecks(): Promise<void> {
    const results = await runHealthChecks();
    const unhealthy = results.filter((entry) => entry.status !== 'ok');
    if (unhealthy.length > 0) {
      logger.warn({ unhealthy }, 'One or more health checks reported non-OK status');
    }
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    if (this.telegram) {
      await this.telegram.stop();
      this.telegram = null;
    }

    if (this.metricsServer) {
      await new Promise<void>((resolve, reject) => {
        this.metricsServer?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.metricsServer = null;
    }

    this.started = false;
  }

  public getSubmitter(): TransactionSubmitter {
    return this.submitter;
  }
}
