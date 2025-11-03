import { rpc, wallet } from './legacy/config';
import { LAMPORTS_PER_SOL, SystemProgram, TransactionMessage } from '@solana/web3.js';

/**
 * Calculate position size (SOL) based on account balance and risk parameters.
 * - balanceSol: current SOL balance
 * - riskPercent: fraction of balance to risk per trade (e.g., 0.02 for 2%)
 * - maxPerTradeSol: cap per trade
 * - minPerTradeSol: floor per trade
 */
export const calculatePositionSize = (
  balanceSol: number,
  riskPercent = 0.02,
  maxPerTradeSol = 0.05,
  minPerTradeSol = 0.001
): number => {
  const raw = balanceSol * riskPercent;
  const clipped = Math.max(minPerTradeSol, Math.min(maxPerTradeSol, raw));
  // Round to 6 decimals to avoid tiny dust fractions
  return Math.floor(clipped * 1e6) / 1e6;
};

/**
 * Estimate SOL fee in SOL for a single transaction.
 * This is a conservative static estimate; for production we should query a fee estimator.
 */
export const estimateSolTransactionFee = async (): Promise<number> => {
  try {
    // Build a minimal V0 message (transfer to self) to estimate the network fee
    const latest = await rpc.getLatestBlockhash();
    const ix = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 1 });
    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: [ix]
    }).compileToV0Message();

    // getFeeForMessage returns an object; normalize to lamports
    const feeInfo: any = await rpc.getFeeForMessage(messageV0);
    // Different versions may return { value: lamports } or { value: { fee: lamports } }
    const lamportsFee = typeof feeInfo === 'number'
      ? feeInfo
      : (feeInfo?.value ?? feeInfo)?.fee ?? feeInfo?.value ?? 0;

    const feeSol = Number(lamportsFee) / LAMPORTS_PER_SOL;
    // If fee is zero or invalid, fallback to conservative estimate
    if (!feeSol || feeSol <= 0) return 0.00001;
    return feeSol;
  } catch (e) {
    // Conservative fallback
    return 0.00002;
  }
};

/**
 * Very simple expected upside estimator for a token.
 * Returns a fractional expected upside (e.g., 0.05 == 5%).
 * Uses dexscreener token metrics: volume, liquidity, and 24h price change.
 */
export const estimateExpectedUpside = async (tokenAddress: string): Promise<number> => {
  try {
    const { data } = await (await import('axios')).default.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const pair = data.pairs?.[0];
    if (!pair) return 0;

    const volume24h = parseFloat(pair.volume?.h24 || '0');
    const liquidity = parseFloat(pair.liquidity?.usd || '1');
    const priceChange24h = parseFloat(pair.priceChange?.h24 || '0');

    // Activity ratio: volume relative to liquidity scaled
    const activityRatio = liquidity > 0 ? (volume24h / liquidity) : 0;

    // Basic heuristic:
    // - activityRatio contributes heavily (scaled to percent)
    // - positive recent price momentum adds a small boost
    let scorePercent = activityRatio * 100; // e.g., 0.2 -> 20
    if (priceChange24h > 0) scorePercent += Math.min(10, priceChange24h * 0.5);

    // Clamp between 1% and 50% expected upside
    scorePercent = Math.max(1, Math.min(50, scorePercent));

    return scorePercent / 100; // fraction
  } catch (e) {
    return 0;
  }
};

/** Helper to convert lamports to SOL */
export const lamportsToSol = (lamports: number) => lamports / LAMPORTS_PER_SOL;
