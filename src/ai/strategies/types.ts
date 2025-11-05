export type TradeAction = "BUY" | "SELL" | "HOLD";

export type StrategyId = "EmperorBTC" | "DCA" | "Martingale" | "Reversal";

export interface CandleSnapshot {
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  timestamp?: number;
}

export interface MarketSnapshot {
  priceUsd: number;
  priceChange1hPct?: number;
  priceChange24hPct?: number;
  liquidityUsd?: number;
  volumeUsd24h?: number;
  volatility?: number;
}

export interface PortfolioState {
  basePositionSizeUsd?: number;
  currentExposureUsd?: number;
  maxExposureUsd?: number;
  activeMartingaleSteps?: number;
  averageEntryPriceUsd?: number;
}

export interface TradeIntent {
  side: TradeAction;
  inputMint: string;
  outputMint: string;
  amount: number | string;
  slippageBps?: number;
}

export interface RiskParameters {
  maxRiskPct?: number;
  maxPositionPct?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
}

export interface IndicatorReadings {
  rsi?: number;
  emaTrend?: number;
  momentum?: number;
  orderbookImbalance?: number;
  trendStrength?: number;
}

export interface StrategyContext {
  tokenMint: string;
  symbol?: string;
  market: MarketSnapshot;
  candles?: CandleSnapshot[];
  indicators?: IndicatorReadings;
  portfolio?: PortfolioState;
  risk?: RiskParameters;
  tradeIntent?: TradeIntent;
  metadata?: Record<string, unknown>;
}

export interface StrategyResult {
  id: StrategyId;
  label: string;
  score: number; // 0-1 normalized strength in favor of proposed action
  confidence: number; // 0-1 qualitative confidence
  action: TradeAction;
  reasons: string[];
  context?: Record<string, unknown>;
  weight?: number;
}

export interface StrategyExecutor {
  readonly id: StrategyId;
  readonly label: string;
  readonly defaultWeight: number;
  evaluate(context: StrategyContext): Promise<StrategyResult>;
}

