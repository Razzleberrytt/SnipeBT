import { StrategyContext, StrategyExecutor, StrategyResult, TradeAction } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export const MartingaleStrategy: StrategyExecutor = {
  id: "Martingale",
  label: "Martingale Recovery",
  defaultWeight: 0.9,
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    const priceChange1h = context.market.priceChange1hPct ?? 0;
    const drawdown = priceChange1h < 0 ? Math.abs(priceChange1h) : 0;

    const steps = context.portfolio?.activeMartingaleSteps ?? 0;
    const maxExposure = context.portfolio?.maxExposureUsd ?? Infinity;
    const currentExposure = context.portfolio?.currentExposureUsd ?? 0;
    const exposureRatio = maxExposure === Infinity ? 0 : currentExposure / maxExposure;

    const reasons: string[] = [];
    let action: TradeAction = "HOLD";

    if (priceChange1h < 0) {
      reasons.push(`Short-term drawdown of ${drawdown.toFixed(2)}% detected`);
      if (steps < 3 && exposureRatio < 0.85) {
        action = "BUY";
        reasons.push(`Martingale step ${steps + 1} available`);
      } else {
        reasons.push("Martingale capacity depleted — holding");
      }
    } else if (priceChange1h > 3) {
      action = "SELL";
      reasons.push("Momentum recovery suggests trimming for reset");
    } else {
      reasons.push("No significant deviation — neutral stance");
    }

    const baseScore = priceChange1h < 0 ? 0.55 + clamp(drawdown / 30, 0, 0.4) : 0.45 - clamp(priceChange1h / 40, 0, 0.25);
    const exposurePenalty = clamp(exposureRatio * 0.5, 0, 0.45);
    const stepsPenalty = steps >= 3 ? 0.3 : steps * 0.08;
    const score = clamp(baseScore - (action === "BUY" ? exposurePenalty + stepsPenalty : 0) + (action === "SELL" ? 0.05 : 0), 0, 1);

    const volatility = context.market.volatility ?? 0.02;
    const volatilityPenalty = clamp(volatility / 0.2, 0, 0.4);
    const confidence = clamp(0.65 - stepsPenalty - volatilityPenalty - exposurePenalty, 0.2, 0.85);

    return {
      id: this.id,
      label: this.label,
      score,
      confidence,
      action,
      reasons,
      context: {
        priceChange1hPct: priceChange1h,
        activeSteps: steps,
        exposureRatio,
      },
      weight: this.defaultWeight,
    } satisfies StrategyResult;
  },
};

