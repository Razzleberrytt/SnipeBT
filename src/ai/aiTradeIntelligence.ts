import { loadConfig } from "../config";
import { getQuote, type QuoteRes } from "../router/jupiter";
import { notifyTelegram } from "../ops/telegram";
import {
  DcaStrategy,
  EmperorBTCStrategy,
  MartingaleStrategy,
  ReversalStrategy,
  StrategyContext,
  StrategyExecutor,
  StrategyResult,
  TradeAction,
  TradeIntent,
  StrategyId,
} from "./strategies";
import { AiOrchestrator, createAiOrchestrator } from "./orchestrator";
import { AiGenerateRequest } from "./types";

interface StrategyEvaluationError {
  id: StrategyId | "LLM";
  message: string;
  cause?: unknown;
}

interface LlmRecommendation {
  action: TradeAction;
  confidence: number;
  reasoning: string[];
  riskWarnings?: string[];
  provider?: string;
  latencyMs?: number;
  rawOutput?: string;
  error?: string;
}

export interface TradeDecision {
  action: TradeAction;
  combinedScore: number;
  confidence: number;
  summary: string;
  rationale: string[];
  timestamp: number;
  strategyBreakdown: StrategyResult[];
  llm?: LlmRecommendation & { used: boolean };
  errors: StrategyEvaluationError[];
  quote?: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    latencyMs: number;
    routePlan?: QuoteRes["routePlan"];
    data?: QuoteRes["data"];
    error?: string;
  };
}

export interface AiTradeIntelligenceOptions {
  strategies?: StrategyExecutor[];
  orchestrator?: AiOrchestrator | null;
  useLlmLayer?: boolean;
  llmSystemPrompt?: string;
  llmTimeoutMs?: number;
  notificationsEnabled?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildDefaultStrategies(): StrategyExecutor[] {
  return [EmperorBTCStrategy, DcaStrategy, MartingaleStrategy, ReversalStrategy];
}

function defaultHoldResult(strategy: StrategyExecutor, reason: string): StrategyResult {
  return {
    id: strategy.id,
    label: strategy.label,
    score: 0.5,
    confidence: 0.3,
    action: "HOLD",
    reasons: [reason],
    weight: strategy.defaultWeight,
  } satisfies StrategyResult;
}

function toAmountString(amount: TradeIntent["amount"]): string {
  if (typeof amount === "string") return amount;
  if (!Number.isFinite(amount)) return "0";
  if (amount <= 0) return "0";
  if (Number.isInteger(amount)) return amount.toString();
  const scaled = Math.round(amount * 1_000_000);
  return scaled.toString();
}

function summarizeReasoning(results: StrategyResult[], action: TradeAction): string[] {
  const prioritized = [...results]
    .filter((result) => result.action === action)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));

  if (prioritized.length === 0) {
    const fallback = [...results]
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, 2)
      .flatMap((result) => result.reasons.slice(0, 1));
    return fallback.slice(0, 3);
  }

  return prioritized
    .flatMap((result) => result.reasons.slice(0, 2))
    .filter(Boolean)
    .slice(0, 3);
}

function aggregateStrategyResults(results: StrategyResult[]): {
  action: TradeAction;
  combinedScore: number;
  confidence: number;
} {
  if (results.length === 0) {
    return { action: "HOLD", combinedScore: 0.5, confidence: 0.3 };
  }

  let voteSum = 0;
  let weightSum = 0;
  let confidenceSum = 0;

  for (const result of results) {
    const weight = (result.weight ?? 1) * (0.5 + clamp(result.confidence, 0, 1) / 2);
    const actionVector = result.action === "BUY" ? 1 : result.action === "SELL" ? -1 : 0;
    const intensity = clamp((result.score - 0.5) * 2, -1, 1);
    const vote = actionVector + intensity * 0.5;
    voteSum += vote * weight;
    weightSum += weight;
    confidenceSum += result.confidence;
  }

  const normalized = weightSum === 0 ? 0 : voteSum / weightSum;
  const action: TradeAction = normalized > 0.25 ? "BUY" : normalized < -0.25 ? "SELL" : "HOLD";
  const combinedScore = clamp(0.5 + normalized / 2, 0, 1);
  const confidence = clamp(confidenceSum / results.length, 0, 1);

  return { action, combinedScore, confidence };
}

function buildLlmRequest(
  systemPrompt: string,
  context: StrategyContext,
  results: StrategyResult[],
  fallback: { action: TradeAction; combinedScore: number; confidence: number }
): AiGenerateRequest {
  const breakdown = results.map((result) => ({
    id: result.id,
    label: result.label,
    action: result.action,
    score: Number(result.score.toFixed(4)),
    confidence: Number(result.confidence.toFixed(4)),
    topReasons: result.reasons.slice(0, 3),
  }));

  const userPrompt = `Evaluate the provided modular trading strategies and return a single execution decision in JSON.

MUST respond with a JSON object using this schema:
{
  "action": "BUY" | "SELL" | "HOLD",
  "confidence": number between 0 and 1,
  "reasoning": string[],
  "riskWarnings": string[] (optional)
}

Fallback ensemble decision (if you choose to agree, copy it verbatim):
Action: ${fallback.action}
Combined Score: ${fallback.combinedScore.toFixed(4)}
Confidence: ${fallback.confidence.toFixed(4)}

Return ONLY valid JSON.`;

  return {
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: userPrompt,
      },
    ],
    context: {
      strategyBreakdown: breakdown,
      market: context.market,
      indicators: context.indicators,
      tradeIntent: context.tradeIntent,
      portfolio: context.portfolio,
      risk: context.risk,
    },
    temperature: 0.1,
    maxOutputTokens: 200,
  } satisfies AiGenerateRequest;
}

function extractJsonObject(text: string): any | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (innerError) {
        return null;
      }
    }
  }
  return null;
}

function normalizeLlmDecision(value: any): Omit<LlmRecommendation, "provider" | "latencyMs" | "rawOutput"> | null {
  if (!value || typeof value !== "object") return null;
  const action = value.action;
  const confidence = Number(value.confidence);
  if (action !== "BUY" && action !== "SELL" && action !== "HOLD") return null;
  if (!Number.isFinite(confidence)) return null;
  const reasoning = Array.isArray(value.reasoning)
    ? value.reasoning.map(String).filter(Boolean).slice(0, 6)
    : [];
  const riskWarnings = Array.isArray(value.riskWarnings)
    ? value.riskWarnings.map(String).filter(Boolean).slice(0, 6)
    : undefined;

  return {
    action,
    confidence: clamp(confidence, 0, 1),
    reasoning,
    riskWarnings,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error("llm_timeout"));
      }, timeoutMs);
    }),
  ]) as Promise<T>;
}

export class AiTradeIntelligence {
  private readonly strategies: StrategyExecutor[];
  private readonly orchestrator: AiOrchestrator | null;
  private readonly useLlmLayer: boolean;
  private readonly systemPrompt: string;
  private readonly llmTimeoutMs: number;
  private readonly notificationsEnabled: boolean;
  private readonly slippageBps: number;

  constructor(options: AiTradeIntelligenceOptions = {}) {
    const cfg = loadConfig();
    this.strategies = options.strategies ?? buildDefaultStrategies();
    this.useLlmLayer = options.useLlmLayer ?? Boolean(cfg.AI_STRATEGY_USE_LLM);
    this.systemPrompt = options.llmSystemPrompt ?? cfg.AI_STRATEGY_LLM_SYSTEM_PROMPT;
    this.llmTimeoutMs = options.llmTimeoutMs ?? cfg.AI_STRATEGY_LLM_TIMEOUT_MS;
    this.notificationsEnabled = options.notificationsEnabled ?? Boolean(cfg.AI_STRATEGY_ENABLE_NOTIFICATIONS);
    this.slippageBps = cfg.SLIPPAGE_BPS;
    this.orchestrator = this.useLlmLayer ? options.orchestrator ?? createAiOrchestrator() : null;
  }

  async evaluate(context: StrategyContext): Promise<TradeDecision> {
    const evaluationPayloads = await Promise.all(
      this.strategies.map(async (strategy) => {
        try {
          const result = await strategy.evaluate(context);
          return { result, error: null as StrategyEvaluationError | null };
        } catch (error) {
          const message = error instanceof Error ? error.message : "unknown error";
          return {
            result: defaultHoldResult(strategy, `Execution failed: ${message}`),
            error: { id: strategy.id, message, cause: error } satisfies StrategyEvaluationError,
          };
        }
      })
    );

    const evaluations = evaluationPayloads.map((payload) => payload.result);
    const errors = evaluationPayloads
      .map((payload) => payload.error)
      .filter((error): error is StrategyEvaluationError => Boolean(error));

    const fallback = aggregateStrategyResults(evaluations);
    const rationale = summarizeReasoning(evaluations, fallback.action);

    const decision: TradeDecision = {
      action: fallback.action,
      combinedScore: fallback.combinedScore,
      confidence: fallback.confidence,
      summary: `${fallback.action} (${(fallback.confidence * 100).toFixed(1)}% confidence)`,
      rationale,
      timestamp: Date.now(),
      strategyBreakdown: evaluations,
      errors,
    };

    let llmDetails: LlmRecommendation | null = null;
    if (this.useLlmLayer && this.orchestrator) {
      llmDetails = await this.enrichWithLlm(context, evaluations, fallback);
      const llmUsed = llmDetails && !llmDetails.error;
      decision.llm = {
        used: Boolean(llmUsed),
        ...(llmDetails ?? {
          action: decision.action,
          confidence: decision.confidence,
          reasoning: decision.rationale,
        }),
      };

      if (llmDetails && !llmDetails.error) {
        decision.action = llmDetails.action;
        decision.confidence = llmDetails.confidence;
        decision.summary = `${llmDetails.action} (${(llmDetails.confidence * 100).toFixed(1)}% AI confidence)`;
        if (llmDetails.reasoning?.length) {
          decision.rationale = llmDetails.reasoning;
        }
      } else if (llmDetails?.error) {
        decision.errors.push({ id: "LLM", message: `LLM layer failed: ${llmDetails.error}` });
      }
    }

    if (context.tradeIntent) {
      decision.quote = await this.fetchQuote(context.tradeIntent);
    }

    if (this.notificationsEnabled) {
      await this.notify(decision, context.tradeIntent ?? null);
    }

    return decision;
  }

  private async fetchQuote(intent: TradeIntent): Promise<TradeDecision["quote"]> {
    const started = Date.now();
    try {
      const amount = toAmountString(intent.amount);
      const slippageBps = intent.slippageBps ?? this.slippageBps;
      const data = await getQuote({
        inputMint: intent.inputMint,
        outputMint: intent.outputMint,
        amount,
        slippageBps,
      });
      return {
        inputMint: intent.inputMint,
        outputMint: intent.outputMint,
        amount,
        slippageBps,
        latencyMs: Date.now() - started,
        data: data.data,
        routePlan: data.routePlan,
        error: data.error,
      };
    } catch (error) {
      return {
        inputMint: intent.inputMint,
        outputMint: intent.outputMint,
        amount: toAmountString(intent.amount),
        slippageBps: intent.slippageBps ?? this.slippageBps,
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : "unknown error",
      };
    }
  }

  private async notify(decision: TradeDecision, intent: TradeIntent | null): Promise<void> {
    const lines = [
      `🤖 Trade Decision: ${decision.action}`,
      `Confidence: ${(decision.confidence * 100).toFixed(1)}% (score ${decision.combinedScore.toFixed(2)})`,
    ];

    if (intent) {
      lines.push(`Route: ${intent.inputMint} → ${intent.outputMint}`);
      lines.push(`Amount: ${typeof intent.amount === "string" ? intent.amount : intent.amount.toString()}`);
    }

    if (decision.rationale.length > 0) {
      lines.push("Top Signals:");
      for (const reason of decision.rationale.slice(0, 3)) {
        lines.push(`• ${reason}`);
      }
    }

    await notifyTelegram(lines.join("\n"));
  }

  private async enrichWithLlm(
    context: StrategyContext,
    evaluations: StrategyResult[],
    fallback: { action: TradeAction; combinedScore: number; confidence: number }
  ): Promise<LlmRecommendation> {
    if (!this.orchestrator) {
      return {
        action: fallback.action,
        confidence: fallback.confidence,
        reasoning: fallback.action === "HOLD" ? [] : summarizeReasoning(evaluations, fallback.action),
        error: "llm_unavailable",
      };
    }

    const request = buildLlmRequest(this.systemPrompt, context, evaluations, fallback);
    const started = Date.now();

    try {
      const result = await withTimeout(this.orchestrator.generate(request), this.llmTimeoutMs, () => undefined);
      const primary = result.primary;

      if (!primary) {
        return {
          action: fallback.action,
          confidence: fallback.confidence,
          reasoning: [],
          error: result.errors.map((err) => `${err.provider}: ${err.message}`).join("; ") || "no_provider",
        };
      }

      const normalized = normalizeLlmDecision(extractJsonObject(primary.output));
      if (!normalized) {
        return {
          action: fallback.action,
          confidence: fallback.confidence,
          reasoning: fallback.action === "HOLD" ? [] : summarizeReasoning(evaluations, fallback.action),
          provider: primary.provider,
          latencyMs: Date.now() - started,
          rawOutput: primary.output,
          error: "invalid_llm_format",
        };
      }

      return {
        ...normalized,
        provider: primary.provider,
        latencyMs: Date.now() - started,
        rawOutput: primary.output,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return {
        action: fallback.action,
        confidence: fallback.confidence,
        reasoning: fallback.action === "HOLD" ? [] : summarizeReasoning(evaluations, fallback.action),
        provider: undefined,
        latencyMs: Date.now() - started,
        rawOutput: undefined,
        error: message,
      };
    }
  }
}

