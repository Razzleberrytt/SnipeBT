import { StrategyContext, StrategyExecutor, StrategyResult, TradeAction } from "./types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export const DcaStrategy: StrategyExecutor = {
  id: "DCA",
  label: "DCA Trend Accumulator",
  defaultWeight: 0.8,
  async evaluate(context: StrategyContext): Promise<StrategyResult> {
    const priceChange = context.market.priceChange24hPct ?? 0;
    const dropMagnitude = priceChange < 0 ? Math.abs(priceChange) : 0;
    const rallyMagnitude = priceChange > 0 ? priceChange : 0;

    const baseScore = priceChange < 0 ? 0.55 + clamp(dropMagnitude / 40, 0, 0.35) : 0.45 - clamp(rallyMagnitude / 60, 0, 0.3);

    let action: TradeAction = "HOLD";
    const reasons: string[] = [];

    if (priceChange < 0) {
      reasons.push(`Price is down ${dropMagnitude.toFixed(2)}% over 24h`);
      if (dropMagnitude >= 12) {
        action = "BUY";
        reasons.push("Favorable DCA opportunity given deep pullback");
      } else if (dropMagnitude >= 5) {
        action = "BUY";
        reasons.push("Moderate pullback aligns with DCA accumulation");
      } else {
        action = "HOLD";
        reasons.push("Minor decline — maintain existing allocations");
      }
    } else if (priceChange > 0) {
      reasons.push(`Price rallied ${rallyMagnitude.toFixed(2)}% over 24h`);
      if (rallyMagnitude > 15) {
        action = "SELL";
        reasons.push("Consider trimming position after extended rally");
      } else {
        action = "HOLD";
        reasons.push("No averaging opportunity during upswing");
      }
    } else {
      reasons.push("Flat 24h movement — neutral stance");
    }

    const portfolio = context.portfolio;
    const basePosition = portfolio?.basePositionSizeUsd ?? 0;
    const currentExposure = portfolio?.currentExposureUsd ?? 0;
    const maxExposure = portfolio?.maxExposureUsd ?? Infinity;

    let exposureRatio = 0;
    if (basePosition > 0) {
      exposureRatio = currentExposure / (maxExposure || basePosition);
    }

    if (exposureRatio >= 0.9 && action === "BUY") {
      reasons.push("Exposure near cap — throttling DCA signal");
    }

    const exposurePenalty = clamp(exposureRatio * 0.4, 0, 0.35);
    const score = clamp(baseScore - (action === "BUY" ? exposurePenalty : 0), 0, 1);

    const confidenceBase = priceChange === 0 ? 0.45 : clamp(0.6 + dropMagnitude / 50 - exposurePenalty, 0.25, 0.85);
    const confidence = action === "HOLD" ? confidenceBase - 0.1 : confidenceBase;

    return {
      id: this.id,
      label: this.label,
      score,
      confidence: clamp(confidence, 0.2, 0.9),
      action,
      reasons,
      context: {
        basePosition,
        currentExposure,
        maxExposure,
        priceChange24hPct: priceChange,
      },
      weight: this.defaultWeight,
    } satisfies StrategyResult;
  },
};

