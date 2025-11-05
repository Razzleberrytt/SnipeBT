import {
  CandleSnapshot,
  StrategyContext,
  StrategyExecutor,
  StrategyResult,
  TradeAction,
} from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function scoreCandlePattern(candle: CandleSnapshot | undefined): {
  score: number;
  action: TradeAction;
  rationale: string[];
} {
  if (!candle) {
    return {
      score: 0.5,
      action: "HOLD",
      rationale: ["No recent candle data available"],
    };
  }

  const range = candle.high - candle.low;
  const body = candle.close - candle.open;
  const direction = body === 0 ? 0 : body > 0 ? 1 : -1;

  if (range <= 0) {
    return {
      score: 0.5,
      action: "HOLD",
      rationale: ["Flat candle range"],
    };
  }

  const bodyStrength = Math.abs(body) / range;
  const upperWick = candle.high - Math.max(candle.close, candle.open);
  const lowerWick = Math.min(candle.close, candle.open) - candle.low;
  const lowerWickRatio = lowerWick / range;
  const upperWickRatio = upperWick / range;

  let score = 0.5 + direction * (bodyStrength * 0.35);
  const rationale: string[] = [];

  if (direction > 0) {
    rationale.push("Bullish close above open");
    if (lowerWickRatio > 0.4) {
      score += 0.15;
      rationale.push("Long lower wick suggests demand absorption");
    }
    if (upperWickRatio < 0.2) {
      score += 0.1;
      rationale.push("Limited profit-taking on top wick");
    }
  } else if (direction < 0) {
    rationale.push("Bearish close below open");
    if (upperWickRatio > 0.45) {
      score -= 0.15;
      rationale.push("Extended upper wick indicates rejection");
    }
    if (lowerWickRatio < 0.2) {
      score -= 0.1;
      rationale.push("Minimal demand response on lower wick");
    }
  } else {
    rationale.push("Doji pattern detected");
  }

  score = clamp(score, 0, 1);
  let action: TradeAction = "HOLD";
  if (score >= 0.62) action = "BUY";
  else if (score <= 0.38) action = "SELL";

  return { score, action, rationale };
}

function pickReferenceCandle(candles: CandleSnapshot[] | undefined): CandleSnapshot | undefined {
  if (!candles || candles.length === 0) return undefined;
  const preferred = candles.find((candle) => candle.timeframe === "1m");
  if (preferred) return preferred;
  return candles[candles.length - 1];
}

export const EmperorBTCStrategy: StrategyExecutor = {
  id: "EmperorBTC",
  label: "EmperorBTC Pattern Recognition",
  defaultWeight: 1.0,
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    const candle = pickReferenceCandle(context.candles);
    const { score, action, rationale } = scoreCandlePattern(candle);

    const volume = candle?.volume ?? context.market.volumeUsd24h;
    const volumeConfidence = volume ? clamp(Math.log10(volume + 10) / 6, 0.2, 0.95) : 0.45;
    const volatility = context.market.volatility ?? 0.02;
    const volatilityPenalty = clamp(volatility / 0.15, 0, 0.35);

    const confidence = clamp(volumeConfidence - volatilityPenalty, 0.2, 0.95);

    return {
      id: this.id,
      label: this.label,
      score,
      confidence,
      action,
      reasons: rationale,
      context: {
        timeframe: candle?.timeframe,
        close: candle?.close,
        open: candle?.open,
        volume,
      },
      weight: this.defaultWeight,
    };
  },
};

