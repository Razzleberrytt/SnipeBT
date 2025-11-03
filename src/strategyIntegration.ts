// Example integration of Strategy Manager into main.ts
// This shows how to incorporate multiple trading strategies

import { StrategyManager } from './strategies/strategyManager';
import { getStrategyConfig } from './strategies/configs';
import { TokenMetrics, PositionInfo } from './strategies/baseStrategy';
import { validateToken } from './validate';
import { executeSnipeSwap } from './trade';
import { calculatePositionSize } from './utils';
import { checkAndTakeProfit, getEntryPrice } from './positionManager';
import { tradeNotifier } from './notifications';
import { rpc, wallet } from './legacy/config';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import axios from 'axios';

// CLI argument helper
const ARG = (name: string) => {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : '';
};

// Initialize strategy manager with chosen configuration
let strategyManager: StrategyManager;

// Add this to your main.ts initialization
export async function initializeStrategies() {
  // Choose strategy mode based on CLI arg or environment
  const strategyMode = ARG('--strategy-mode') || process.env.STRATEGY_MODE || 'balanced';
  
  console.log(`🧠 Initializing trading strategies in '${strategyMode}' mode...`);
  
  const config = getStrategyConfig(strategyMode as any);
  if (!config) {
    console.error(`Unknown strategy mode: ${strategyMode}`);
    process.exit(1);
  }
  
  strategyManager = new StrategyManager(config);
  
  const activeStrategies = strategyManager.getActiveStrategies();
  console.log(`✅ Active strategies: ${activeStrategies.join(', ')}`);
  
  // Send notification about strategy setup
  if (tradeNotifier) {
    await tradeNotifier.sendGeneralAlert(
      `🧠 Strategy Manager Initialized\\n` +
      `Mode: ${strategyMode}\\n` +
      `Active: ${activeStrategies.join(', ')}\\n` +
      `Decision Mode: ${config.decisionMode}\\n` +
      `Min Confidence: ${config.minConfidenceThreshold}`
    );
  }
}

// Modified token validation function that uses strategies
export async function validateTokenWithStrategies(
  tokenAddress: string, 
  existingPosition?: any
): Promise<{ isValid: boolean; decision?: any; reason: string; shouldBlacklist?: boolean }> {
  
  // First run basic validation (rug check, liquidity, etc.)
  const basicValidation = await validateToken(tokenAddress);
  if (!basicValidation) {
    return { isValid: false, reason: 'Failed basic validation', shouldBlacklist: true };
  }
  
  // Get enhanced metrics for strategy analysis
  const metrics = await getEnhancedTokenMetrics(tokenAddress);
  if (!metrics) {
    return { isValid: false, reason: 'Could not get token metrics', shouldBlacklist: true };
  }
  
  // Convert existing position format if needed
  let positionInfo: PositionInfo | undefined;
  if (existingPosition) {
    const entryPrice = getEntryPrice(tokenAddress);
    positionInfo = {
      address: tokenAddress,
      amount: existingPosition.amount || 0,
      entryPrice: entryPrice || undefined,
      currentPrice: metrics.price,
      pnlPercent: existingPosition.pnlPercent || 0,
      ageMinutes: existingPosition.ageMinutes || 0
    };
  }
  
  // Get strategy decision
  const decision = await strategyManager.analyzeToken(tokenAddress, metrics, positionInfo);
  
  // Log strategy decision
  console.log(`🧠 Strategy Decision for ${tokenAddress}:`);
  console.log(`   Action: ${decision.finalAction} (confidence: ${(decision.confidence * 100).toFixed(1)}%)`);
  console.log(`   Reason: ${decision.reason}`);
  
  if (decision.strategyBreakdown.length > 0) {
    console.log(`   Strategy Breakdown:`);
    decision.strategyBreakdown.forEach(({ strategy, signal, weight }) => {
      console.log(`     ${strategy}: ${signal.action} (${(signal.confidence * 100).toFixed(1)}%, weight: ${weight})`);
    });
  }
  
  // Send strategy notification for significant decisions
  if (decision.finalAction !== 'HOLD' && decision.confidence > 0.6 && tradeNotifier) {
    await tradeNotifier.sendGeneralAlert(
      `🧠 Strategy Signal: ${decision.finalAction}\\n` +
      `Token: ${tokenAddress.slice(0, 8)}...\\n` +
      `Confidence: ${(decision.confidence * 100).toFixed(1)}%\\n` +
      `Reason: ${decision.reason.slice(0, 100)}...\\n` +
      `Amount: ${decision.amount || 'default'} SOL`
    );
  }
  
  // Only BUY is valid for execution
  // HOLD/SELL don't blacklist - allow re-evaluation when market changes
  return {
    isValid: decision.finalAction === 'BUY',
    decision,
    reason: decision.reason,
    shouldBlacklist: false  // Never blacklist strategy decisions - they change with market
  };
}

// Enhanced metrics gathering function
async function getEnhancedTokenMetrics(tokenAddress: string): Promise<TokenMetrics | null> {
  try {
    // Get basic metrics from existing validation
    const [rugCheckResult, dexScreenerResult] = await Promise.all([
      axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report/summary`, { timeout: 5000 }),
      axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 })
    ]);
    
    const rugScore = Number(rugCheckResult.data?.score || 0);
    const pair = dexScreenerResult.data?.pairs?.[0];
    
    if (!pair) return null;
    
    const metrics: TokenMetrics = {
      price: parseFloat(pair.priceUsd || '0'),
      priceChange24h: parseFloat(pair.priceChange?.h24 || '0'),
      volume24h: parseFloat(pair.volume?.h24 || '0'),
      volume1h: parseFloat(pair.volume?.h1 || '0'),
      liquidity: parseFloat(pair.liquidity?.usd || '0'),
      txCount24h: (parseInt(pair.txns?.h24?.buy || '0') + parseInt(pair.txns?.h24?.sell || '0')) || 0,
      txCount5m: (parseInt(pair.txns?.m5?.buy || '0') + parseInt(pair.txns?.m5?.sell || '0')) || 0,
      txCount1h: (parseInt(pair.txns?.h1?.buy || '0') + parseInt(pair.txns?.h1?.sell || '0')) || 0,
      rugScore
    };
    
    // Add technical indicators if price history is available
    if (pair.priceHistory) {
      const prices = pair.priceHistory.map((p: any) => parseFloat(p.price));
      if (prices.length > 14) {
        // Calculate RSI using the TrendReversalStrategy helper
        const { TrendReversalStrategy } = await import('./strategies/trendReversalStrategy');
        metrics.rsi = TrendReversalStrategy.calculateRSI(prices);
      }
    }
    
    return metrics;
  } catch (error) {
    console.error(`Error getting enhanced metrics for ${tokenAddress}:`, error);
    return null;
  }
}

// Modified trade execution that respects strategy decisions
export async function executeStrategyBasedTrade(tokenAddress: string, decision: any) {
  if (!decision || decision.finalAction === 'HOLD') {
    return;
  }
  
  try {
    // Get current balance for position sizing if decision doesn't provide amount
    let amount = decision.amount;
    if (!amount) {
      const balance = await rpc.getBalance(wallet.publicKey);
      const balanceSol = balance / LAMPORTS_PER_SOL;
      amount = calculatePositionSize(balanceSol, 0.03, 0.05, 0.001); // 3% risk, max 0.05 SOL
    }
    
    if (decision.finalAction === 'BUY') {
      console.log(`🚀 Executing strategy-based BUY for ${tokenAddress}`);
      console.log(`   Amount: ${amount} SOL`);
      console.log(`   Strategy: ${decision.reason}`);
      
      const result = await executeSnipeSwap(tokenAddress, amount);
      
      if (result.success && tradeNotifier) {
        await tradeNotifier.sendTradeAlert({
          type: 'BUY',
          tokenAddress: tokenAddress,
          tokenSymbol: decision.metadata?.symbol || 'UNKNOWN',
          amount: amount,
          price: result.price || 0,
          totalValue: amount * (result.price || 0),
          timestamp: new Date(),
          txSignature: result.signature
        });
      }
      
      return result;
    }
    
    if (decision.finalAction === 'SELL') {
      console.log(`💰 Executing strategy-based SELL for ${tokenAddress}`);
      console.log(`   Strategy: ${decision.reason}`);
      
      // Use existing position management logic with proper parameters
      const minProfitPct = 0.5; // 0.5% minimum profit
      const slippageBps = 40; // 0.4% slippage
      const dryRun = false; // Live trading
      
      const result = await checkAndTakeProfit(minProfitPct, slippageBps, dryRun);
      
      if (result && result.length > 0 && tradeNotifier) {
        await tradeNotifier.sendGeneralAlert(
          `💰 Strategy SELL executed\\n` +
          `Token: ${tokenAddress.slice(0, 8)}...\\n` +
          `Reason: ${decision.reason}\\n` +
          `Confidence: ${(decision.confidence * 100).toFixed(1)}%`
        );
      }
      
      return result;
    }
  } catch (error) {
    console.error(`Error executing strategy-based trade:`, error);
    
    if (tradeNotifier) {
      await tradeNotifier.sendErrorAlert(
        `Strategy trade failed`,
        {
          token: tokenAddress.slice(0, 8),
          action: decision.finalAction,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      );
    }
  }
}

// Export for use in main.ts
export { strategyManager };