// @ts-nocheck

console.log('Script starting...');

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

import { loadConfig } from '../config';
import { insertTrade, listTrades } from '../db';
import { subscribeToNewPools, PoolSubscription } from '../stream';
import { fetchNewTokens, validateToken } from '../validate';
import { executeSnipeSwap, executeRoundTripSwap, previewRoundTrip, executeMultiInputSwap } from '../trade';
import { calculatePositionSize, estimateExpectedUpside } from '../utils';
import { checkAndTakeProfit, getHeldPositions, checkAndStopLoss, setEntryPrice, getEntryPrice } from '../positionManager';
import { 
  rpc, 
  wallet, 
  CONSTANTS, 
  getConnectionHealth, 
  initializeAndLog 
} from './config';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { tradeNotifier } from '../notifications';
import { initializeStrategies, validateTokenWithStrategies, strategyManager } from '../strategyIntegration';
import { initializeAIMonitor, monitorTokenWithAI, stopMonitoringToken, shutdownAIMonitor } from '../aiIntegration';
import { AITradeIntelligence } from '../aiTradeIntelligence';
import axios from 'axios';
import * as readline from 'readline';

loadConfig();

// Active positions tracking for Anti-Martingale strategy
interface ActivePosition {
  tokenAddress: string;
  symbol: string;
  entryPrice: number;
  amount: number;
  entryTime: Date;
  doublingCount: number; // Track how many times we've doubled on wins
  profitTarget: number; // AI-calculated dynamic profit target %
  profitTargetReasoning?: string; // Why this target was chosen
}

const activePositions = new Map<string, ActivePosition>();

// AI Trade Intelligence instance (module-level)
let aiIntelligence: AITradeIntelligence | null = null;

// Track market regime changes
let lastMarketRegime: string | null = null;

type TradeHistoryEntry = { type: 'BUY' | 'SELL'; symbol: string; timestamp: Date; pnlPercent?: number };

function loadTradeHistory(): TradeHistoryEntry[] {
  const rows = listTrades(500);
  return rows.map((row) => ({
    type: row.side,
    symbol: row.symbol ?? row.positionId ?? 'UNKNOWN',
    timestamp: new Date(row.createdAt),
    pnlPercent: row.pnlPercent ?? undefined
  }));
}

function persistTradeHistoryEntry(entry: TradeHistoryEntry): void {
  insertTrade({
    symbol: entry.symbol,
    positionId: entry.symbol,
    side: entry.type,
    createdAt: entry.timestamp.getTime(),
    pnlPercent: entry.pnlPercent ?? null
  });
}

// Function to fix missing entry prices for existing positions
async function fixMissingEntryPrices() {
  try {
    const positions = await getHeldPositions();
    console.log(`Checking ${positions.length} positions for missing entry prices...`);

    for (const pos of positions) {
      const existingPrice = getEntryPrice(pos.mint);
      if (!existingPrice) {
        console.log(`Position ${pos.mint} missing entry price, attempting to set...`);

        // Try to get current price from multiple sources
        let currentPrice = null;

        try {
          const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${pos.mint}`, { timeout: 3000 });
          const pair = dexRes.data.pairs?.[0];
          if (pair?.priceUsd) {
            currentPrice = parseFloat(pair.priceUsd);
          }
        } catch (e) {
          // Try Jupiter as fallback
          try {
            const jupiterRes = await axios.get(`https://price.jup.ag/v4/price?ids=${pos.mint}`, { timeout: 3000 });
            const priceData = jupiterRes.data.data?.[pos.mint];
            if (priceData?.price) {
              currentPrice = parseFloat(priceData.price);
            }
          } catch (jupiterError) {
            console.log(`Could not get price for ${pos.mint}`);
          }
        }

        if (currentPrice) {
          // For existing positions, we use current price as entry price
          // This isn't perfect but better than no entry price for stop-loss
          setEntryPrice(pos.mint, currentPrice);
          console.log(`✅ Set entry price for existing position ${pos.mint}: $${currentPrice.toFixed(6)}`);
        } else {
          console.warn(`❌ Could not determine price for existing position ${pos.mint}`);
        }
      }
    }
  } catch (error) {
    console.error('Error fixing missing entry prices:', error);
  }
}

// CLI flags for targeted testing and tuning
const ARG = (name: string) => {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : '';
};
const ARG_NUM = (name: string) => {
  const v = ARG(name);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// Strategy mode selection
const STRATEGY_MODE = ARG('--strategy-mode') || process.env.STRATEGY_MODE || 'emperorBTC';
const USE_STRATEGIES = process.argv.includes('--use-strategies') || process.env.USE_STRATEGIES === 'true' || STRATEGY_MODE !== undefined;

// Allow buying on HOLD decisions (when token passed validation but strategy says wait)
const ALLOW_HOLD_BUYS = process.argv.includes('--allow-hold-buys') || process.env.ALLOW_HOLD_BUYS === 'true';
const MIN_HOLD_CONFIDENCE = (() => {
  const cli = ARG_NUM('--min-hold-confidence');
  if (cli && cli > 0) return cli;
  const envVal = Number(process.env.MIN_HOLD_CONFIDENCE || '');
  // If HOLD has 40%+ confidence, it's worth buying (token passed validation)
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 0.4;
})();

const SKIP_VALIDATE = process.argv.includes('--skip-validate');
const FORCED_TOKEN = ARG('--token');
const ROUND_TRIP = process.argv.includes('--roundtrip') || process.env.ROUND_TRIP === 'true';
const AUTO_TAKEPROFIT = process.argv.includes('--auto-tp') || process.env.AUTO_TAKEPROFIT === 'true';
const TAKEPROFIT_MIN_PCT = (() => {
  const cli = ARG_NUM('--tp-min-pct');
  if (cli && cli > 0) return cli;
  const envVal = Number(process.env.TAKEPROFIT_MIN_PCT || '');
  // Lowered to 2% for faster profit-taking in high-volume markets - covers fees + small profit
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 2.0;
})();
const TAKEPROFIT_CHECK_INTERVAL_MS = (() => {
  const cli = ARG_NUM('--tp-interval-ms');
  if (cli && cli > 0) return cli;
  const envVal = Number(process.env.TAKEPROFIT_CHECK_INTERVAL_MS || '');
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 60000; // Check every 60 seconds (was 30s)
})();
const AUTO_STOPLOSS = process.argv.includes('--auto-sl') || process.env.AUTO_STOPLOSS === 'true';
const STOPLOSS_PCT = (() => {
  const cli = ARG_NUM('--sl-pct');
  if (cli && cli > 0) return cli;
  const envVal = Number(process.env.STOPLOSS_PCT || '');
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 20;
})();
const STOPLOSS_CHECK_INTERVAL_MS = (() => {
  const cli = ARG_NUM('--sl-interval-ms');
  if (cli && cli > 0) return cli;
  const envVal = Number(process.env.STOPLOSS_CHECK_INTERVAL_MS || '');
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 30000;
})();
const MULTI_INPUT_ENABLED = process.argv.includes('--multi-input') || process.env.MULTI_INPUT_ENABLED === 'true';
const SEEN_TTL_MIN = (() => {
  const cli = ARG_NUM('--seen-ttl-mins');
  if (cli && cli > 0) return cli;
  const envVal = Number(process.env.SEEN_TTL_MINS || '');
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 15;
})();
const recentlyAnalyzed = new Map<string, number>();
const isRecentlyAnalyzed = (addr: string) => {
  const exp = recentlyAnalyzed.get(addr);
  if (!exp) return false;
  if (Date.now() < exp) return true;
  recentlyAnalyzed.delete(addr);
  return false;
};
const markAnalyzed = (addr: string) => {
  recentlyAnalyzed.set(addr, Date.now() + SEEN_TTL_MIN * 60 * 1000);
};
const TARGET_MULT = (() => {
  const cli = ARG_NUM('--target-mult');
  if (cli && cli > 1) return cli;
  const envVal = Number(process.env.PROFIT_TARGET_MULT || '');
  return Number.isFinite(envVal) && envVal > 1 ? envVal : undefined;
})();

let activeSubscriptions: PoolSubscription | null = null;
const activeTransactions = new Set<string>();
const tokenBlacklist = new Set<string>();
let cachedHeldPositions: any[] = []; // Cache positions to avoid RPC spam
const recentTrades: TradeHistoryEntry[] = loadTradeHistory();
const metrics = {
  opportunitiesFound: 0,
  successfulTrades: 0,
  failedTrades: 0,
  totalProfit: 0,
  startTime: Date.now(),
  endTime: 0
};
let BASELINE_BALANCE_SOL = 0;

const TRADE_CONFIG = {
  maxConcurrentTrades: 10,  // INCREASED to allow new big positions alongside old small ones
  minProfitThreshold: 0.005,  // 0.5% - aggressive but still safe
  maxSlippageBps: 150,  // Increased from 100 - allows trades on less liquid tokens
  tradeAmountSol: 0.15,  // INCREASED from 0.06 to 0.15 (~$28 per trade) for REAL profits
  riskPercent: 0.02,
  minTradeSol: 0.05,  // Increased from 0.01 - bigger minimum for better profit per trade
  maxTradeSol: 0.2,  // INCREASED from 0.06 to 0.2 (~$37 max) - go big!
  dryRun: !(process.argv.includes('--live') || process.env.DRY_RUN === 'false'),
  monitoringIntervalMs: 30000, // Back to 30s - faster scanning with more capital
  errorRetryDelayMs: 5000,
  maxDailyTrades: 100,
};

const overrideMinProfit = ARG_NUM('--min-profit');
if (overrideMinProfit !== undefined) TRADE_CONFIG.minProfitThreshold = overrideMinProfit;
const overrideSlippage = ARG_NUM('--slippage-bps');
if (overrideSlippage !== undefined) TRADE_CONFIG.maxSlippageBps = overrideSlippage;
const overrideRisk = ARG_NUM('--risk');
if (overrideRisk !== undefined) TRADE_CONFIG.riskPercent = overrideRisk;
const overrideMinTrade = ARG_NUM('--min-trade');
if (overrideMinTrade !== undefined) TRADE_CONFIG.minTradeSol = overrideMinTrade;
const overrideMaxTrade = ARG_NUM('--max-trade');
if (overrideMaxTrade !== undefined) TRADE_CONFIG.maxTradeSol = overrideMaxTrade;
const overrideAmount = ARG_NUM('--amount-sol');
if (overrideAmount !== undefined) TRADE_CONFIG.tradeAmountSol = overrideAmount;

const ONESHOT = process.argv.includes('--once');

// Safety: require explicit confirmation for live mode unless --confirm-live is passed

async function confirmLiveOrExit(): Promise<void> {
  const live = process.argv.includes('--live') || process.env.DRY_RUN === 'false';
  const bypass = process.argv.includes('--confirm-live');
  if (!live || bypass) return;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('\nLIVE MODE ENABLED. This will execute REAL on-chain trades.\nType CONFIRM to proceed (or anything else to abort): ', (ans) => {
      resolve(ans || '');
    });
  });
  rl.close();
  if (answer.trim() !== 'CONFIRM') {
    console.log('Live execution aborted by user (confirmation not provided).');
    process.exit(0);
  }
  console.log('Live confirmation accepted — proceeding with live execution.');
}

const handleError = async (error: unknown, context: string) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Error in ${context}:`, errorMessage);
  if (errorMessage.includes('insufficient balance') || errorMessage.includes('Rate limit exceeded')) {
    await stopBot('Critical error: ' + errorMessage);
  }
};

const stopBot = async (reason: string) => {
  console.log(`Stopping bot: ${reason}`);
  if (activeSubscriptions) {
    try {
      activeSubscriptions.unsubscribe();
      activeSubscriptions = null;
    } catch (error) {
      console.error('Error during unsubscribe:', error);
    }
  }
  const runTime = (Date.now() - metrics.startTime) / (1000 * 60 * 60);
  console.log('Final Performance Metrics:', {
    ...metrics,
    runTimeHours: runTime.toFixed(2),
    successRate: ((metrics.successfulTrades / (metrics.successfulTrades + metrics.failedTrades)) * 100).toFixed(2) + '%',
    averageHourlyTrades: (metrics.successfulTrades / runTime).toFixed(2),
    averageProfitPerTrade: (metrics.totalProfit / metrics.successfulTrades).toFixed(4) + ' SOL'
  });
  process.exit(0);
};

const evaluateBestRoute = async (
  targetMint: string,
  solAmount: number
): Promise<{ useSol: boolean; inputMint?: string; inputAmount?: bigint; netExpected?: number }> => {
  if (!MULTI_INPUT_ENABLED) return { useSol: true };
  try {
    const positions = await getHeldPositions();
    if (!positions || positions.length === 0) return { useSol: true };
    const stables = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];
    const nonStables = positions.filter(p => !stables.includes(p.mint));
    if (nonStables.length === 0) return { useSol: true };
    const candidate = nonStables.reduce((prev, curr) => BigInt(curr.amount) > BigInt(prev.amount) ? curr : prev);
    console.log(`Evaluating multi-input route: ${candidate.mint.slice(0, 8)}... (${candidate.amount.slice(0, 6)}...) vs SOL`);
    const axios = await import('axios');
    const quoteHolding = await axios.default.get(
      `${process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag'}/swap/v1/quote`,
      { params: { inputMint: candidate.mint, outputMint: targetMint, amount: candidate.amount, slippageBps: TRADE_CONFIG.maxSlippageBps }, timeout: 8000 }
    ).then(r => r.data).catch(() => null);
    if (!quoteHolding || !quoteHolding.outAmount) {
      console.log('Multi-input quote failed; falling back to SOL');
      return { useSol: true };
    }
    const outAmountHolding = BigInt(quoteHolding.outAmount);
    const impactHolding = parseFloat(quoteHolding.priceImpactPct || '0');
    const quoteSol = await axios.default.get(
      `${process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag'}/swap/v1/quote`,
      { params: { inputMint: CONSTANTS.NATIVE_MINT.toBase58(), outputMint: targetMint, amount: Math.floor(solAmount * LAMPORTS_PER_SOL).toString(), slippageBps: TRADE_CONFIG.maxSlippageBps }, timeout: 8000 }
    ).then(r => r.data).catch(() => null);
    if (!quoteSol || !quoteSol.outAmount) {
      console.log('SOL quote failed; cannot compare routes');
      return { useSol: true };
    }
    const outAmountSol = BigInt(quoteSol.outAmount);
    const impactSol = parseFloat(quoteSol.priceImpactPct || '0');
    const scoreHolding = Number(outAmountHolding) * (1 - impactHolding / 100);
    const scoreSol = Number(outAmountSol) * (1 - impactSol / 100);
    console.log(`Route comparison: holding score=${scoreHolding.toFixed(0)}, SOL score=${scoreSol.toFixed(0)}`);
    if (scoreHolding > scoreSol * 1.05) {
      console.log(`Using holding ${candidate.mint.slice(0, 8)}... as input (better route)`);
      return { useSol: false, inputMint: candidate.mint, inputAmount: BigInt(candidate.amount), netExpected: (scoreHolding - scoreSol) / scoreSol };
    } else {
      console.log('Using SOL as input (best route)');
      return { useSol: true };
    }
  } catch (err) {
    console.warn('Multi-input evaluation failed:', err instanceof Error ? err.message : err);
    return { useSol: true };
  }
};

const initializeMetrics = () => {
  if (process.argv.includes('--hours')) {
    const hours = parseFloat(process.argv[process.argv.indexOf('--hours') + 1]);
    if (!isNaN(hours)) {
      metrics.endTime = Date.now() + (hours * 60 * 60 * 1000);
      console.log(`Bot will run for ${hours} hours until ${new Date(metrics.endTime).toISOString()}`);
    } else {
      console.error('Invalid --hours value provided');
      process.exit(1);
    }
  } else {
    metrics.endTime = 0;
  }
};

const processTradeOpportunity = async (tokenAddress: string) => {
  // In strategy mode, let strategies decide - don't skip based on "recently analyzed"
  if (!USE_STRATEGIES && isRecentlyAnalyzed(tokenAddress)) {
    console.log('Recently analyzed, skipping', tokenAddress);
    return;
  }
  if (activeTransactions.size >= TRADE_CONFIG.maxConcurrentTrades) {
    console.log('Max concurrent trades reached, skipping opportunity');
    return;
  }
  if (!SKIP_VALIDATE && tokenBlacklist.has(tokenAddress)) {
    console.log('Token in blacklist, skipping');
    return;
  }
  
  // PROFIT-FOCUSED: Check if we already have an active position
  // For Anti-Martingale: only buy more if position is WINNING
  const existingPos = activePositions.get(tokenAddress);
  if (existingPos) {
    console.log(`Already holding ${tokenAddress} (${existingPos.symbol}), checking if should double on win...`);
    // Strategy will decide if we should double based on profit
  }
  
  try {
    metrics.opportunitiesFound++;
    if (!getConnectionHealth()) {
      throw new Error('RPC connection unhealthy');
    }
    const balanceLamports = await rpc.getBalance(wallet.publicKey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
    let dynamicSize = calculatePositionSize(balanceSol, TRADE_CONFIG.riskPercent, TRADE_CONFIG.maxTradeSol, TRADE_CONFIG.minTradeSol);
    let isValid = true;
    let strategyDecision: any = null;
    
    // Use strategy-based validation if enabled
    if (USE_STRATEGIES && !SKIP_VALIDATE) {
      console.log(`Validating token: ${tokenAddress}`);
      
      // Pass existing position to strategy for Anti-Martingale logic
      let positionData = undefined;
      if (existingPos) {
        // Get current price to calculate PnL
        try {
          const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 3000 });
          const currentPrice = parseFloat(dexRes.data.pairs?.[0]?.priceUsd || '0');
          if (currentPrice > 0) {
            const pnlPercent = ((currentPrice - existingPos.entryPrice) / existingPos.entryPrice) * 100;
            const ageMinutes = (Date.now() - existingPos.entryTime.getTime()) / (1000 * 60);
            positionData = {
              amount: existingPos.amount,
              pnlPercent,
              ageMinutes
            };
          }
        } catch (e) {
          console.log(`Could not get current price for position check`);
        }
      }
      
      const validation = await validateTokenWithStrategies(tokenAddress, positionData);
      isValid = validation.isValid;
      strategyDecision = validation.decision;
      
      // Check if HOLD should be treated as BUY
      const isHoldWithGoodConfidence = !isValid && 
        strategyDecision?.finalAction === 'HOLD' && 
        strategyDecision?.confidence >= MIN_HOLD_CONFIDENCE;
      
      if (ALLOW_HOLD_BUYS && isHoldWithGoodConfidence) {
        console.log(`✅ Token ${tokenAddress} HOLD decision with ${(strategyDecision.confidence * 100).toFixed(1)}% confidence - treating as BUY`);
        console.log(`   Reason: ${strategyDecision.reason}`);
        isValid = true; // Convert HOLD to BUY
      } else if (!isValid) {
        console.log(`Token ${tokenAddress} rejected by strategies: ${validation.reason}`);
        // Only blacklist hard failures (rug check, liquidity) - not strategy HOLD decisions
        if (validation.shouldBlacklist) {
          tokenBlacklist.add(tokenAddress);
          console.log(`  ⛔ Blacklisted (hard failure)`);
        } else {
          console.log(`  ⏸️ Not blacklisted (will re-evaluate when market changes)`);
        }
        markAnalyzed(tokenAddress);
        return;
      }
      
      if (isValid) {
        console.log(`✅ Token ${tokenAddress} approved by strategies`);
        console.log(`   Strategy: ${strategyDecision.reason}`);
        console.log(`   Confidence: ${(strategyDecision.confidence * 100).toFixed(1)}%`);
        
        // AI VALIDATION - Final sanity check before trade
        if (aiIntelligence) {
          console.log('🧠 Running AI trade validator...');
          try {
            // Get current positions count
            const heldPositions = await getHeldPositions();
            const currentPositions = heldPositions.length;
            
            // Prepare market context for AI
            const marketContext = {
              tokenAddress,
              symbol: tokenAddress.slice(0, 8) + '...',
              price: 0, // Will be fetched by AI
              priceChange24h: 0,
              volume24h: 0,
              liquidity: 0,
              rvol: 1.0,
            };
            
            // Get strategy signals for AI analysis
            const strategySignals = {
              combined: strategyDecision.confidence,
              // Extract individual strategy signals if available
              candlestick: strategyDecision.signals?.candlestick,
              martingale: strategyDecision.signals?.martingale,
              trendReversal: strategyDecision.signals?.trendReversal,
              dca: strategyDecision.signals?.dca,
            };
            
            // Run AI validation
            const aiValidation = await aiIntelligence.validateTradeEntry(
              strategySignals,
              marketContext,
              currentPositions
            );
            
            console.log(`🤖 AI Decision: ${aiValidation.approved ? 'APPROVED' : 'REJECTED'}`);
            console.log(`   Confidence: ${(aiValidation.confidence * 100).toFixed(1)}%`);
            console.log(`   Risk Level: ${aiValidation.riskLevel}`);
            console.log(`   Reasoning: ${aiValidation.reasoning}`);
            
            if (aiValidation.warnings.length > 0) {
              console.log(`   ⚠️  Warnings: ${aiValidation.warnings.join(', ')}`);
            }
            
            // Send AI validation notification (for rejections or low confidence)
            await tradeNotifier.sendAIValidation({
              tokenSymbol: marketContext.symbol,
              tokenAddress: tokenAddress,
              approved: aiValidation.approved,
              confidence: aiValidation.confidence,
              riskLevel: aiValidation.riskLevel,
              reasoning: aiValidation.reasoning,
              warnings: aiValidation.warnings,
              signalStrength: strategySignals.combined
            });
            
            // Reject if AI says no (unless user overrides)
            if (!aiValidation.approved && !process.env.SKIP_AI_VALIDATION) {
              console.log(`❌ AI REJECTED this trade - not executing`);
              markAnalyzed(tokenAddress);
              return;
            }
            
            // Get AI position sizing recommendation
            console.log('💰 AI calculating optimal position size...');
            const recentPerf = aiIntelligence.getRecentPerformance();
            const marketRegime = await aiIntelligence.detectMarketRegime(recentPerf);
            
            console.log(`📊 Market Regime: ${marketRegime.regime} (${marketRegime.riskAppetite})`);
            console.log(`   Reasoning: ${marketRegime.reasoning}`);
            console.log(`   Position Multiplier: ${marketRegime.recommendedPositionMultiplier}x`);
            
            // Check for regime change and notify
            if (lastMarketRegime && lastMarketRegime !== marketRegime.regime) {
              await tradeNotifier.sendAIRegimeChange({
                from: lastMarketRegime,
                to: marketRegime.regime,
                riskAppetite: marketRegime.riskAppetite,
                positionMultiplier: marketRegime.recommendedPositionMultiplier,
                reasoning: marketRegime.reasoning,
                confidence: marketRegime.confidence
              });
            }
            lastMarketRegime = marketRegime.regime;
            
            const baseAmount = dynamicSize || TRADE_CONFIG.tradeAmountSol;
            const positionSizeRec = await aiIntelligence.recommendPositionSize(
              baseAmount,
              strategySignals,
              marketRegime,
              recentPerf.winRate
            );
            
            console.log(`💵 AI Position Size: ${positionSizeRec.solAmount.toFixed(4)} SOL (${positionSizeRec.riskAdjustment}x base)`);
            console.log(`   Reasoning: ${positionSizeRec.reasoning}`);
            
            // Send AI position sizing notification (if significant adjustment)
            await tradeNotifier.sendAIPositionSize({
              tokenSymbol: marketContext.symbol,
              baseAmount: baseAmount,
              recommendedAmount: positionSizeRec.solAmount,
              adjustment: positionSizeRec.riskAdjustment,
              reasoning: positionSizeRec.reasoning,
              confidence: aiValidation.confidence
            });
            
            // Override trade size with AI recommendation
            dynamicSize = positionSizeRec.solAmount;
            
          } catch (aiError: any) {
            console.error('⚠️  AI validation failed:', aiError.message);
            console.log('Continuing with trade (AI failure non-blocking)');
          }
        }
      }
    } else if (!SKIP_VALIDATE) {
      // Fallback to basic validation
      console.log(`Validating token: ${tokenAddress}`);
      isValid = await validateToken(tokenAddress);
      if (!isValid) {
        tokenBlacklist.add(tokenAddress);
        markAnalyzed(tokenAddress);
        return;
      }
    } else {
      console.log('Skipping validation due to --skip-validate flag');
    }
    if (!TRADE_CONFIG.dryRun) {
      try {
        const probe = await executeSnipeSwap(tokenAddress, dynamicSize || TRADE_CONFIG.tradeAmountSol, { slippageBps: TRADE_CONFIG.maxSlippageBps, maxRetries: 1, timeoutMs: 8000, dryRun: true });
        const costPercent = probe?.costPercent ?? 0;
        const expectedUpside = await estimateExpectedUpside(tokenAddress);
        const netExpected = expectedUpside - costPercent;
        console.log(`Pre-trade check for ${tokenAddress}: cost%=${(costPercent * 100).toFixed(2)}%, upside=${(expectedUpside * 100).toFixed(2)}%, net=${(netExpected * 100).toFixed(2)}% (min=${(TRADE_CONFIG.minProfitThreshold * 100).toFixed(2)}%)`);
        if (netExpected < TRADE_CONFIG.minProfitThreshold) {
          console.log(`Skipping live trade for ${tokenAddress} — net expected ${(netExpected * 100).toFixed(2)}% < min ${(TRADE_CONFIG.minProfitThreshold * 100).toFixed(2)}%`);
          return;
        }
      } catch (probeErr) {
        console.warn(`Pre-trade probe failed for ${tokenAddress}:`, probeErr instanceof Error ? probeErr.message : probeErr);
        return;
      }
    }
    const route = await evaluateBestRoute(tokenAddress, dynamicSize || TRADE_CONFIG.tradeAmountSol);
    let tradeResult: any;
    if (!route.useSol && route.inputMint && route.inputAmount) {
      console.log(`Executing multi-input swap: ${route.inputMint.slice(0, 8)}... -> ${tokenAddress.slice(0, 8)}...`);
      tradeResult = await executeMultiInputSwap(route.inputMint, route.inputAmount, tokenAddress, TRADE_CONFIG.maxSlippageBps, TRADE_CONFIG.dryRun, 10000);
      if (!TRADE_CONFIG.dryRun && tradeResult.signature !== 'DRY_RUN') {
        console.log('Multi-input swap executed; routing back to SOL via auto take-profit');
      }
    } else if (!TRADE_CONFIG.dryRun && ROUND_TRIP) {
      console.log('Round-trip mode enabled: previewing two-leg SOL->token->SOL');
      try {
        const preview = await previewRoundTrip(tokenAddress, dynamicSize || TRADE_CONFIG.tradeAmountSol, TRADE_CONFIG.maxSlippageBps, 10000);
        const estNetPct = (Number(preview.estFinalLamports - preview.inputLamports) / Number(preview.inputLamports)) * 100;
        console.log(`Round-trip preview net: ${estNetPct.toFixed(2)}%`);
      } catch (e) {
        console.warn('Round-trip preview failed; skipping this token for safety');
        return;
      }
      tradeResult = await executeRoundTripSwap(tokenAddress, dynamicSize || TRADE_CONFIG.tradeAmountSol, { slippageBps: TRADE_CONFIG.maxSlippageBps, maxRetries: 2, timeoutMs: 10000, dryRun: false, minProfitThresholdPct: TRADE_CONFIG.minProfitThreshold * 100 });
    } else {
      tradeResult = await executeSnipeSwap(tokenAddress, dynamicSize || TRADE_CONFIG.tradeAmountSol, { slippageBps: TRADE_CONFIG.maxSlippageBps, maxRetries: 2, timeoutMs: 10000, dryRun: TRADE_CONFIG.dryRun });
    }
    // Set entry price for stop loss tracking - more robust implementation
    if (!TRADE_CONFIG.dryRun && tradeResult.signature !== 'DRY_RUN') {
      try {
        // Try multiple sources for price data
        let entryPrice = null;

        // First try Dexscreener
        try {
          const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 3000 });
          const pair = dexRes.data.pairs?.[0];
          if (pair?.priceUsd) {
            entryPrice = parseFloat(pair.priceUsd);
          }
        } catch (dexError) {
          console.log(`Dexscreener failed for entry price, trying Jupiter...`);
        }

        // Fallback to Jupiter API
        if (!entryPrice) {
          try {
            const jupiterRes = await axios.get(`https://price.jup.ag/v4/price?ids=${tokenAddress}`, { timeout: 3000 });
            const priceData = jupiterRes.data.data?.[tokenAddress];
            if (priceData?.price) {
              entryPrice = parseFloat(priceData.price);
            }
          } catch (jupiterError) {
            console.log(`Jupiter API also failed for entry price`);
          }
        }

        // Last resort: estimate based on trade amount
        if (!entryPrice) {
          // Rough estimate: assume token price gives us reasonable distribution
          entryPrice = 0.01; // Conservative default
          console.log(`Using estimated entry price for ${tokenAddress}: $${entryPrice}`);
        }

        if (entryPrice) {
          setEntryPrice(tokenAddress, entryPrice);
          console.log(`✅ Set entry price for ${tokenAddress}: $${entryPrice.toFixed(6)}`);
        } else {
          console.warn(`❌ Could not determine entry price for ${tokenAddress}`);
        }
      } catch (e) {
        console.warn(`Failed to set entry price for ${tokenAddress}:`, e instanceof Error ? e.message : e);
      }
    }
    if (tradeResult.success) {
      metrics.successfulTrades++;
      console.log(`Successful trade: ${tradeResult.signature}`);

      // Send Telegram notification for successful trade
      try {
        const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 3000 });
        const pair = dexRes.data.pairs?.[0];
        const entryPrice = pair?.priceUsd ? parseFloat(pair.priceUsd) : 0;

        // Track trade for status updates
        const tradeEntry: TradeHistoryEntry = {
          type: 'BUY',
          symbol: pair?.baseToken?.symbol || tokenAddress,
          timestamp: new Date(),
          pnlPercent: undefined
        };
        recentTrades.push(tradeEntry);
        persistTradeHistoryEntry(tradeEntry);

        // Track active position for Anti-Martingale strategy
        if (existingPos) {
          // Increment doubling count on additional buy
          existingPos.doublingCount++;
          existingPos.amount += (dynamicSize || TRADE_CONFIG.tradeAmountSol);
          console.log(`💪 Anti-Martingale: Doubled position #${existingPos.doublingCount} - Total: ${existingPos.amount.toFixed(3)} SOL`);
        } else {
          // Calculate dynamic profit target using AI
          let profitTarget = TAKEPROFIT_MIN_PCT; // Default fallback
          let profitTargetReasoning = 'Default fixed target';
          
          if (aiIntelligence && pair) {
            try {
              const dynamicTarget = aiIntelligence.calculateDynamicProfitTarget(
                pair.priceChange?.h24 || 0,
                pair.volume?.h24 && pair.liquidity?.usd ? 
                  (pair.volume.h24 / pair.liquidity.usd) : 1.0,
                pair.volume?.h24 || 0,
                pair.liquidity?.usd || 0,
                0.7 // aiValidation.confidence would be available from context
              );
              
              profitTarget = dynamicTarget.target;
              profitTargetReasoning = dynamicTarget.reasoning;
              
              console.log(`🎯 AI Dynamic Profit Target: ${profitTarget.toFixed(1)}%`);
              console.log(`   ${profitTargetReasoning}`);
              
            } catch (err: any) {
              console.warn(`⚠️  Dynamic profit target calculation failed: ${err.message}`);
            }
          }
          
          // New initial position
          activePositions.set(tokenAddress, {
            tokenAddress,
            symbol: pair?.baseToken?.symbol || 'UNKNOWN',
            entryPrice,
            amount: dynamicSize || TRADE_CONFIG.tradeAmountSol,
            entryTime: new Date(),
            doublingCount: 0,
            profitTarget,
            profitTargetReasoning
          });
          console.log(`📍 New position: ${pair?.baseToken?.symbol} @ $${entryPrice.toFixed(6)} - ${(dynamicSize || TRADE_CONFIG.tradeAmountSol).toFixed(3)} SOL`);
          console.log(`   🎯 Profit Target: ${profitTarget.toFixed(1)}% (AI-optimized)`);
          
          // Start AI monitoring for new position
          monitorTokenWithAI(
            tokenAddress,
            pair?.baseToken?.symbol || 'UNKNOWN',
            (signal) => {
              console.log(`\n🤖 AI SIGNAL for ${pair?.baseToken?.symbol}:`, signal);
              if (signal.action === 'SELL' && signal.confidence >= 80) {
                console.log(`🚨 AI recommends SELL with ${signal.confidence}% confidence!`);
                console.log(`   Pattern: ${signal.pattern}`);
                console.log(`   Reason: ${signal.reasoning}`);
              }
            }
          ).catch(err => console.error('[AI Monitor] Failed to start monitoring:', err));
        }

        await tradeNotifier.sendTradeAlert({
          type: 'BUY',
          tokenAddress,
          tokenSymbol: pair?.baseToken?.symbol || 'UNKNOWN',
          amount: dynamicSize || TRADE_CONFIG.tradeAmountSol,
          price: entryPrice,
          totalValue: (dynamicSize || TRADE_CONFIG.tradeAmountSol),
          timestamp: new Date(),
          txSignature: tradeResult.signature
        });
      } catch (notifyError) {
        console.warn('Failed to send trade notification:', notifyError instanceof Error ? notifyError.message : notifyError);
      }
    }
    markAnalyzed(tokenAddress);
  } catch (error) {
    metrics.failedTrades++;
    await handleError(error, `Trade processing for ${tokenAddress}`);
    markAnalyzed(tokenAddress);
  }
};

const sendPeriodicStatusUpdate = async () => {
  try {
    const balanceLamports = await rpc.getBalance(wallet.publicKey);
    const currentBalance = balanceLamports / LAMPORTS_PER_SOL;
    
    // Get current positions with prices
    const positions = await getHeldPositions();
    const positionsWithPrices = await Promise.all(
      positions
        .filter(p => p.mint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') // Skip USDC
        .map(async (p) => {
          const entryPrice = getEntryPrice(p.mint);
          let currentPrice = 0;
          let pnlPercent = undefined;
          let symbol = 'UNKNOWN';
          
          try {
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.mint}`, { timeout: 5000 });
            const pair = dexRes.data.pairs?.[0];
            currentPrice = pair?.priceUsd ? parseFloat(pair.priceUsd) : 0;
            symbol = pair?.baseToken?.symbol || 'UNKNOWN';
            
            if (entryPrice && currentPrice > 0) {
              pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
            }
          } catch (e) {
            // Silent fail for price fetch
          }

          // Estimate value in SOL
          const valueSOL = p.uiAmount * currentPrice / 150; // Rough SOL conversion (assuming SOL ~$150)
          
          return {
            symbol,
            amount: p.uiAmount,
            valueSOL,
            entryPrice: entryPrice ?? undefined, // Convert null to undefined
            currentPrice,
            pnlPercent
          };
        })
    );

    // Get trades from the past hour
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    const recentHourTrades = recentTrades.filter(t => t.timestamp.getTime() > oneHourAgo);

    await tradeNotifier.sendStatusUpdate({
      balance: currentBalance,
      baselineBalance: BASELINE_BALANCE_SOL,
      positions: positionsWithPrices,
      recentTrades: recentHourTrades,
      metrics: {
        opportunitiesFound: metrics.opportunitiesFound,
        successfulTrades: metrics.successfulTrades,
        failedTrades: metrics.failedTrades,
        totalProfitSOL: metrics.totalProfit,
        runTimeMinutes: (Date.now() - metrics.startTime) / 1000 / 60
      }
    });
  } catch (error) {
    console.error('Failed to send periodic status update:', error);
  }
};

const main = async () => {
  try {
    console.log('Bot starting up...');
    // Confirm live execution if requested
    await confirmLiveOrExit();
    initializeMetrics();
    console.log(`Time limit set: Will run until ${new Date(metrics.endTime).toISOString()}`);
    console.log('Initializing configuration...');
    await initializeAndLog();
    
    // Initialize multi-strategy system
    console.log('🧠 Initializing multi-strategy trading system...');
    await initializeStrategies();
    
    // Initialize AI Monitor with Grok
    const grokApiKey = process.env.XAI_API_KEY;
    const twitterBearer = process.env.TWITTER_BEARER_TOKEN;
    
    if (grokApiKey) {
      initializeAIMonitor(grokApiKey);
      aiIntelligence = new AITradeIntelligence(grokApiKey, twitterBearer);
      console.log('🤖 AI Candlestick Monitor enabled (xAI Grok)');
      console.log('🧠 AI Trade Intelligence enabled (validation, sizing, regime detection)');
      if (twitterBearer) {
        console.log('🐦 Twitter sentiment monitoring enabled');
      }
    } else {
      console.log('⚠️  XAI_API_KEY not set, AI monitoring disabled');
    }
    
    try {
      const baseLamports = await rpc.getBalance(wallet.publicKey);
      BASELINE_BALANCE_SOL = baseLamports / LAMPORTS_PER_SOL;
      console.log(`Baseline balance set: ${BASELINE_BALANCE_SOL.toFixed(4)} SOL`);
      if (TARGET_MULT) {
        console.log(`Profit target active: ×${TARGET_MULT} ⇒ ${(BASELINE_BALANCE_SOL * TARGET_MULT).toFixed(4)} SOL`);
        
        // Set session baseline for EmperorBTC strategy if active
        const emperorStrategy = strategyManager?.getActiveStrategies().includes('emperorBTC');
        if (emperorStrategy) {
          await import('./strategies/emperorBTCStrategy');
          const empStrategy = strategyManager as any;
          const empInstance = empStrategy.strategies?.get?.('emperorBTC') as any;
          if (empInstance?.setSessionBaseline) {
            empInstance.setSessionBaseline(BASELINE_BALANCE_SOL, TARGET_MULT);
          }
        }
      }
    } catch (e) {
      console.warn('Unable to establish baseline balance for profit target:', e instanceof Error ? e.message : e);
    }

    // Fix missing entry prices for existing positions
    await fixMissingEntryPrices();

    console.log('Trade Configuration:', { ...TRADE_CONFIG, environment: process.env.ENVIRONMENT, profitTargetMultiplier: TARGET_MULT });
    if (FORCED_TOKEN) {
      console.log(`Forced token mode: attempting ${FORCED_TOKEN} (${SKIP_VALIDATE ? 'validation skipped' : 'with validation'})`);
      await processTradeOpportunity(FORCED_TOKEN);
      await stopBot('Forced token test complete');
      return;
    }
    if (ONESHOT) {
      console.log('Running in one-shot test mode (--once)');
      const tokens = await fetchNewTokens();
      console.log(`Found ${tokens.length} tokens to analyze`);
      for (const token of tokens) {
        await processTradeOpportunity(token.baseToken.address);
      }
      console.log('One-shot run complete; exiting.');
      await stopBot('One-shot test complete');
      return;
    }
    activeSubscriptions = subscribeToNewPools(async (_sig, slot) => {
      try {
        console.log(`New opportunity detected at slot ${slot}`);
        const tokens = await fetchNewTokens();
        for (const token of tokens) {
          await processTradeOpportunity(token.baseToken.address);
        }
      } catch (err) {
        await handleError(err, 'Pool subscription callback');
      }
    });
    const scanAndMonitor = async () => {
      console.log('\n--- Starting scan cycle ---');
      console.log('Scanning for new tokens...');
      
      // PROFIT-FOCUSED: Fetch held positions ONCE per cycle (not per token) to avoid RPC spam
      try {
        cachedHeldPositions = await getHeldPositions();
        console.log(`Currently holding ${cachedHeldPositions.length} positions`);
      } catch (e) {
        console.warn('Failed to fetch positions (using empty cache):', e instanceof Error ? e.message : e);
        cachedHeldPositions = [];
      }
      
      const tokens = await fetchNewTokens();
      const fresh = tokens.filter((t: any) => !isRecentlyAnalyzed(t.baseToken.address));
      console.log(`Found ${tokens.length} tokens; ${fresh.length} new to analyze (seen TTL ${SEEN_TTL_MIN}m)`);
      
      // Process ALL tokens that passed initial filters, not just fresh ones
      // The strategy system will decide if they're worth trading
      const tokensToAnalyze = USE_STRATEGIES ? tokens : fresh;
      console.log(`Analyzing ${tokensToAnalyze.length} tokens (strategy mode: ${USE_STRATEGIES ? 'ALL tokens' : 'fresh only'})`);
      
      if (tokensToAnalyze.length > 0) {
        for (const token of tokensToAnalyze) {
          console.log(`Processing token: ${token.baseToken.address}`);
          await processTradeOpportunity(token.baseToken.address);
        }
      }
      console.log('\nCurrent Metrics:', {
        opportunitiesFound: metrics.opportunitiesFound, successfulTrades: metrics.successfulTrades,
        failedTrades: metrics.failedTrades, runTime: `${((Date.now() - metrics.startTime) / 1000 / 60).toFixed(2)} minutes`
      });
      if (metrics.endTime) {
        const remainingTime = (metrics.endTime - Date.now()) / 1000;
        console.log(`Time remaining: ${remainingTime.toFixed(0)} seconds`);
      }
    };
    console.log('\nStarting monitoring cycle...');
    
    // Send initial status update
    setTimeout(() => sendPeriodicStatusUpdate(), 5000); // Wait 5s for first scan to complete
    
    // AI Market Summary - every 15 minutes
    if (aiIntelligence) {
      setInterval(async () => {
        try {
          await sendAIMarketSummary();
        } catch (err) {
          console.error('Error sending AI market summary:', err);
        }
      }, 15 * 60 * 1000); // 15 minutes
    }
    
    setInterval(async () => {
      try {
        await scanAndMonitor();
      } catch (err) {
        await handleError(err, 'Periodic scan cycle');
      }
    }, TRADE_CONFIG.monitoringIntervalMs);
    scanAndMonitor().catch(async (err) => {
      await handleError(err, 'Initial scan cycle');
    });
    console.log(`SnipeBT v2 running in ${process.env.ENVIRONMENT} mode. Press Ctrl+C to stop.`);
    process.on('SIGINT', () => stopBot('User interrupted'));
    process.on('SIGTERM', () => stopBot('Termination signal received'));
    if (AUTO_TAKEPROFIT) {
      console.log(`Auto take-profit enabled: checking every ${TAKEPROFIT_CHECK_INTERVAL_MS / 1000}s with AI-optimized dynamic targets`);
      setInterval(async () => {
        try {
          // For each active position, check if it hit its custom profit target
          const sellResults: any[] = [];
          
          for (const [tokenAddress, activePos] of activePositions) {
            const targetProfitPct = activePos.profitTarget || TAKEPROFIT_MIN_PCT;
            
            // Get current price and calculate P&L
            try {
              const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 3000 });
              const pair = dexRes.data.pairs?.[0];
              const currentPrice = pair?.priceUsd ? parseFloat(pair.priceUsd) : 0;
              
              if (currentPrice > 0 && activePos.entryPrice > 0) {
                const pnlPercent = ((currentPrice - activePos.entryPrice) / activePos.entryPrice) * 100;
                
                if (pnlPercent >= targetProfitPct) {
                  console.log(`🎯 Position ${activePos.symbol} hit target: ${pnlPercent.toFixed(2)}% >= ${targetProfitPct.toFixed(1)}%`);
                  
                  // Execute sell using standard checkAndTakeProfit
                  const sigs = await checkAndTakeProfit(targetProfitPct, TRADE_CONFIG.maxSlippageBps, TRADE_CONFIG.dryRun);
                  if (sigs.length > 0) {
                    sellResults.push(...sigs);
                  }
                  break; // Only sell one at a time per check
                }
              }
            } catch (priceError) {
              // Silently skip if price check fails
            }
          }
          
          if (sellResults.length > 0) {
            console.log(`Auto take-profit executed ${sellResults.length} sells with dynamic targets`);
            metrics.successfulTrades += sellResults.length;

            // Send notifications for take-profit sells
            for (const result of sellResults) {
              try {
                // Track sell trade for status updates
                const tradeEntry: TradeHistoryEntry = {
                  type: 'SELL',
                  symbol: result.tokenSymbol,
                  timestamp: new Date(),
                  pnlPercent: result.pnlPercent
                };
                recentTrades.push(tradeEntry);
                persistTradeHistoryEntry(tradeEntry);

                // Remove from active positions (position closed)
                const pos = activePositions.get(result.tokenAddress);
                if (pos) {
                  stopMonitoringToken(result.tokenAddress);
                  activePositions.delete(result.tokenAddress);
                  console.log(`📤 Closed position: ${result.tokenSymbol} @ ${result.pnlPercent.toFixed(2)}% profit (${pos.doublingCount} doublings)`);
                  console.log(`   🎯 Target was ${pos.profitTarget.toFixed(1)}% (AI-optimized)`);
                  
                  // Send enhanced profit notification with dynamic target info
                  const targetHitMessage = pos.profitTarget > TAKEPROFIT_MIN_PCT 
                    ? `🚀 Hit AI-optimized target of ${pos.profitTarget.toFixed(1)}% (vs fixed ${TAKEPROFIT_MIN_PCT}%)`
                    : `✅ Hit conservative target of ${pos.profitTarget.toFixed(1)}%`;
                  
                  await tradeNotifier.sendGeneralAlert(
                    `💰 **PROFIT TAKEN**: ${result.tokenSymbol}\n\n` +
                    `📊 **Profit**: +${result.pnlPercent.toFixed(2)}%\n` +
                    `🎯 **Target**: ${targetHitMessage}\n` +
                    `💵 **Amount**: ${pos.amount.toFixed(3)} SOL\n` +
                    `⏱️ **Hold Time**: ${((Date.now() - pos.entryTime.getTime()) / 1000 / 60).toFixed(0)} min\n\n` +
                    `${pos.profitTargetReasoning || ''}`
                  );
                  
                  // AI POST-TRADE ANALYSIS
                  if (aiIntelligence) {
                    console.log('🧠 Running AI post-trade analysis...');
                    try {
                      const entrySignals = {
                        combined: 0.7, // Would need to store actual entry signals
                        candlestick: undefined,
                        martingale: undefined,
                        trendReversal: undefined,
                        dca: undefined,
                      };
                      
                      const positionInfo = {
                        tokenMint: result.tokenAddress,
                        symbol: result.tokenSymbol,
                        entryPrice: pos.entryPrice,
                        currentPrice: result.exitPrice,
                        amountSOL: pos.amount,
                        tokenAmount: 0,
                        pnlPercent: result.pnlPercent,
                        pnl: result.pnl,
                      };
                      
                      const analysis = await aiIntelligence.analyzeCompletedTrade(
                        positionInfo,
                        entrySignals,
                        result.exitPrice,
                        'Take Profit Triggered'
                      );
                      
                      console.log(`📊 AI Trade Analysis (${analysis.outcome}):`);
                      console.log(`   ${analysis.expectedVsActual}`);
                      if (analysis.successFactors.length > 0) {
                        console.log(`   ✅ Success Factors: ${analysis.successFactors.join(', ')}`);
                      }
                      if (analysis.lessonsLearned.length > 0) {
                        console.log(`   📚 Lessons: ${analysis.lessonsLearned.join(', ')}`);
                      }
                      if (Object.keys(analysis.strategyAdjustments).length > 0) {
                        console.log(`   🎯 Strategy Adjustments: ${JSON.stringify(analysis.strategyAdjustments)}`);
                      }
                      
                      // Send AI post-trade analysis notification (if there are lessons)
                      await tradeNotifier.sendAIPostTradeAnalysis({
                        tokenSymbol: result.tokenSymbol,
                        outcome: analysis.outcome,
                        profitPercent: result.pnlPercent,
                        expectedVsActual: analysis.expectedVsActual,
                        successFactors: analysis.successFactors,
                        failureFactors: analysis.failureFactors,
                        lessonsLearned: analysis.lessonsLearned,
                        strategyAdjustments: analysis.strategyAdjustments
                      });

                      // Record trade outcome for adaptive learning
                      const holdTimeMinutes = (Date.now() - pos.entryTime.getTime()) / 1000 / 60;
                      aiIntelligence.recordTradeOutcome(
                        result.tokenAddress,
                        result.tokenSymbol,
                        pos.entryPrice,
                        result.exitPrice,
                        result.pnl,
                        result.pnlPercent,
                        holdTimeMinutes,
                        {
                          volume24h: 0, // Would need to fetch current data
                          liquidity: 0,
                          priceChange24h: result.pnlPercent, // Approximation
                          rvol: 1,
                        },
                        undefined, // candlestick pattern if available
                        entrySignals,
                        0.7 // AI confidence from entry
                      );
                      
                    } catch (aiError: any) {
                      console.error('⚠️  AI post-trade analysis failed:', aiError.message);
                    }
                  }
                }

                await tradeNotifier.sendTradeAlert({
                  type: 'SELL',
                  tokenAddress: result.tokenAddress,
                  tokenSymbol: result.tokenSymbol,
                  amount: result.amount,
                  price: result.exitPrice,
                  totalValue: result.exitValue,
                  pnl: result.pnl,
                  pnlPercent: result.pnlPercent,
                  timestamp: new Date(),
                  txSignature: result.signature
                });
              } catch (notifyError) {
                console.warn('Failed to send take-profit notification:', notifyError instanceof Error ? notifyError.message : notifyError);
              }
            }
          }
        } catch (err) {
          await handleError(err, 'Auto take-profit check');
        }
      }, TAKEPROFIT_CHECK_INTERVAL_MS);
    }
    if (AUTO_STOPLOSS) {
      console.log(`Auto stop-loss enabled: checking every ${STOPLOSS_CHECK_INTERVAL_MS / 1000}s, stop loss ${STOPLOSS_PCT}%`);
      setInterval(async () => {
        try {
          const sigs = await checkAndStopLoss(STOPLOSS_PCT, TRADE_CONFIG.maxSlippageBps, TRADE_CONFIG.dryRun);
          if (sigs.length > 0) {
            console.log(`Auto stop-loss executed ${sigs.length} sells:`, sigs);
            metrics.failedTrades += sigs.length;

            // Send notifications for stop-loss sells
            for (const result of sigs) {
              try {
                await tradeNotifier.sendTradeAlert({
                  type: 'SELL',
                  tokenAddress: result.tokenAddress,
                  tokenSymbol: result.tokenSymbol,
                  amount: result.amount,
                  price: result.exitPrice,
                  totalValue: result.exitValue,
                  pnl: result.pnl,
                  pnlPercent: result.pnlPercent,
                  timestamp: new Date(),
                  txSignature: result.signature
                });
              } catch (notifyError) {
                console.warn('Failed to send stop-loss notification:', notifyError instanceof Error ? notifyError.message : notifyError);
              }
            }
          }
        } catch (err) {
          await handleError(err, 'Auto stop-loss check');
        }
      }, STOPLOSS_CHECK_INTERVAL_MS);
    }
    
    // Periodic status updates every 30 minutes
    console.log('Periodic status updates enabled: every 30 minutes');
    setInterval(async () => {
      await sendPeriodicStatusUpdate();
    }, 30 * 60 * 1000); // 30 minutes
    
    setInterval(async () => {
      try {
        if (!getConnectionHealth()) {
          console.warn('Unhealthy connection detected');
        }
        if (TARGET_MULT) {
          try {
            const bal = await rpc.getBalance(wallet.publicKey);
            const balSol = bal / LAMPORTS_PER_SOL;
            metrics.totalProfit = balSol - BASELINE_BALANCE_SOL;
            const targetSol = BASELINE_BALANCE_SOL * TARGET_MULT;
            if (balSol >= targetSol) {
              console.log(`🎯 PROFIT TARGET REACHED: balance ${balSol.toFixed(4)} SOL ≥ ${targetSol.toFixed(4)} SOL (×${TARGET_MULT})`);
              // Send notification but don't stop the bot
              await tradeNotifier.sendGeneralAlert(`🎯 **PROFIT TARGET REACHED!**

💰 **Current Balance**: ${balSol.toFixed(4)} SOL
🎯 **Target**: ${targetSol.toFixed(4)} SOL (×${TARGET_MULT})
📈 **Total Profit**: +${metrics.totalProfit.toFixed(4)} SOL

*Bot continues running - no auto-stop*`);
            }
          } catch {}
        }
      } catch (err) {
        await handleError(err, 'Periodic health check');
      }
    }, CONSTANTS.HEALTH_CHECK_INTERVAL_MS);
  } catch (error) {
    await handleError(error, 'Main process');
    process.exit(1);
  }
};

/**
 * AI Market Summary - sends every 15 minutes
 */
async function sendAIMarketSummary() {
  if (!aiIntelligence) return;
  
  try {
    const runtime = ((Date.now() - metrics.startTime) / 1000 / 60).toFixed(1);
    const recentPerf = aiIntelligence.getRecentPerformance();
    const marketRegime = await aiIntelligence.detectMarketRegime(recentPerf);
    
    // Build a summary of why no trades
    const reasons: string[] = [];
    
    if (metrics.successfulTrades === 0 && metrics.failedTrades === 0) {
      reasons.push('No strong bullish setups detected');
      if (marketRegime.regime === 'BEAR') {
        reasons.push('Market is in BEAR mode - waiting for reversal');
      } else if (marketRegime.regime === 'SIDEWAYS') {
        reasons.push('Market is choppy/sideways - low conviction signals');
      }
      reasons.push('AI filtering out low-quality opportunities');
      reasons.push('Protecting capital until clear momentum appears');
    }
    
    const message = `📊 **AI Market Summary** (${runtime} min)

🎯 **Market Regime**: ${marketRegime.regime} (${marketRegime.riskAppetite})
💭 **AI Assessment**: ${marketRegime.reasoning}

📈 **Session Stats**:
  • Opportunities scanned: ${metrics.opportunitiesFound}
  • Trades executed: ${metrics.successfulTrades}
  • Current positions: ${cachedHeldPositions?.length || 0}

${metrics.successfulTrades === 0 ? `❓ **Why No Trades Yet?**
${reasons.map(r => `  • ${r}`).join('\n')}

✅ Bot is working correctly - being patient for quality setups!` : `💰 **Active Trading**:
  • Recent performance: ${(recentPerf.winRate * 100).toFixed(1)}% win rate
  • Position multiplier: ${marketRegime.recommendedPositionMultiplier}x`}

📚 **Adaptive Learning**:
${aiIntelligence.getAdaptiveTrendInsights()}

⏰ Next update in 15 minutes`;

    await tradeNotifier.sendGeneralAlert(message);
    console.log('📊 AI market summary sent to Telegram');
    
  } catch (error) {
    console.error('Failed to send AI market summary:', error);
  }
}

// Shutdown handler
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return; // Prevent multiple shutdowns
  isShuttingDown = true;
  
  console.log(`\n${signal} received - shutting down gracefully...`);
  
  // Stop AI monitoring
  shutdownAIMonitor();
  
  try {
    const bal = await rpc.getBalance(wallet.publicKey);
    const balSol = bal / LAMPORTS_PER_SOL;
    const profit = balSol - BASELINE_BALANCE_SOL;
    const runtime = ((Date.now() - metrics.startTime) / 1000 / 60).toFixed(1);
    
    console.log('📤 Sending shutdown notification to Telegram...');
    
    // Send notification with timeout protection
    const notificationPromise = tradeNotifier.sendGeneralAlert(`🛑 **BOT STOPPED**

⏱️ **Runtime**: ${runtime} minutes
💰 **Final Balance**: ${balSol.toFixed(4)} SOL
📊 **Session P&L**: ${profit >= 0 ? '+' : ''}${profit.toFixed(4)} SOL (${profit >= 0 ? '+' : ''}${((profit / BASELINE_BALANCE_SOL) * 100).toFixed(2)}%)
✅ **Successful Trades**: ${metrics.successfulTrades}
❌ **Failed Trades**: ${metrics.failedTrades}`);
    
    // Wait up to 5 seconds for notification
    await Promise.race([
      notificationPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Notification timeout')), 5000))
    ]);
    
    console.log('✅ Shutdown notification sent to Telegram');
    
    // Give extra time for message to be delivered (increased from 1s to 2s)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
  } catch (error) {
    console.error('❌ Error sending shutdown notification:', error);
    // Still wait a bit in case it's delayed
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  console.log('Exiting...');
  process.exit(0);
}

// Handle Ctrl+C on Windows (readline interface)
let rl: any = null;
if (process.platform === 'win32') {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.on('SIGINT', () => {
    rl.close();
    gracefulShutdown('SIGINT (Ctrl+C)');
  });
}

// Standard Unix signals
process.on('SIGINT', () => {
  if (rl) rl.close();
  gracefulShutdown('SIGINT');
});
process.on('SIGTERM', () => {
  if (rl) rl.close();
  gracefulShutdown('SIGTERM');
});

main().catch(async (error) => {
  await handleError(error, 'Application startup');
  process.exit(1);
});