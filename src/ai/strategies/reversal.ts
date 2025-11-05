import { StrategyContext, StrategyExecutor, StrategyResult, TradeAction } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export const ReversalStrategy: StrategyExecutor = {
  id: "Reversal",
  label: "Trend Reversal Detector",
  defaultWeight: 0.85,
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    const indicators = context.indicators ?? {};
    const rsi = indicators.rsi;
    const momentum = indicators.momentum ?? 0;
    const trendStrength = indicators.trendStrength ?? 0;
    const emaTrend = indicators.emaTrend ?? 0;

    let action: TradeAction = "HOLD";
    const reasons: string[] = [];

    if (typeof rsi === "number") {
      if (rsi <= 32) {
        action = "BUY";
        reasons.push(`RSI ${rsi.toFixed(1)} indicates oversold conditions`);
      } else if (rsi >= 68) {
        action = "SELL";
        reasons.push(`RSI ${rsi.toFixed(1)} indicates overbought conditions`);
      } else {
        reasons.push(`RSI ${rsi.toFixed(1)} in neutral zone`);
      }
    } else {
      reasons.push("RSI unavailable — relying on momentum signals");
    }

    if (momentum > 0.6 && action !== "SELL") {
      reasons.push(`Positive momentum ${momentum.toFixed(2)} supporting bullish bounce`);
      action = action === "HOLD" ? "BUY" : action;
    } else if (momentum < -0.6 && action !== "BUY") {
      reasons.push(`Negative momentum ${momentum.toFixed(2)} reinforces downside risk`);
      action = action === "HOLD" ? "SELL" : action;
    }

    const trendOpposition = trendStrength !== 0 ? -trendStrength : -emaTrend;
    if (action === "BUY" && trendOpposition > 0.4) {
      reasons.push("Dominant downtrend reduces reversal conviction");
    }
    if (action === "SELL" && trendOpposition < -0.4) {
      reasons.push("Dominant uptrend reduces downside conviction");
    }

    const rsiComponent = typeof rsi === "number" ? Math.abs(rsi - 50) / 50 : 0.2;
    const momentumComponent = Math.abs(momentum) * 0.5;
    const trendHeadwind = clamp(Math.abs(trendOpposition), 0, 0.6);
    const baseScore = clamp(0.5 + (action === "BUY" ? 0.2 : action === "SELL" ? -0.2 : 0), 0, 1);

    const scoreAdjustment = (rsiComponent + momentumComponent) * (action === "SELL" ? -1 : 1);
    const rawScore = clamp(baseScore + scoreAdjustment, 0, 1);
    const score = action === "HOLD" ? 0.5 : clamp(rawScore - trendHeadwind * 0.25, 0, 1);

    const confidence = clamp(0.55 + rsiComponent * 0.3 + momentumComponent * 0.2 - trendHeadwind * 0.4, 0.2, 0.88);

    return {
      id: this.id,
      label: this.label,
      score,
      confidence,
      action,
      reasons,
      context: {
        rsi,
        momentum,
        trendStrength,
        emaTrend,
      },
      weight: this.defaultWeight,
    } satisfies StrategyResult;
  },
};

