import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import axios from 'axios';
import { rpc, wallet } from './legacy/config';
import { getEntryPriceForMint, setEntryPriceForMint } from './db';

interface TradeResult {
  signature: string;
  tokenAddress: string;
  tokenSymbol: string;
  amount: number;
  exitPrice: number;
  exitValue: number;
  pnl: number;
  pnlPercent: number;
}

export const setEntryPrice = (mint: string, price: number) => {
  setEntryPriceForMint(mint, price);
};

export const getEntryPrice = (mint: string): number | null => {
  return getEntryPriceForMint(mint);
};

interface HeldPosition {
  mint: string;
  amount: string;
  decimals: number;
  uiAmount: number;
}

/**
 * Get all non-zero token positions held by the wallet.
 * Excludes SOL (native) and returns only SPL tokens.
 */
export const getHeldPositions = async (): Promise<HeldPosition[]> => {
  try {
    const tokenAccounts = await rpc.getParsedTokenAccountsByOwner(wallet.publicKey, {
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    });

    return tokenAccounts.value
      .map(acc => {
        const parsed = acc.account.data.parsed.info;
        return {
          mint: parsed.mint,
          amount: parsed.tokenAmount.amount,
          decimals: parsed.tokenAmount.decimals,
          uiAmount: parsed.tokenAmount.uiAmount
        };
      })
      .filter(p => Number(p.amount) > 0);
  } catch (e) {
    console.error('Failed to fetch held positions:', e);
    return [];
  }
};

/**
 * Preview token->SOL swap using Jupiter quote (no execution).
 * Returns estimated net SOL after fees and slippage, or null on error.
 */
export const previewTokenToSol = async (
  tokenMint: string,
  tokenAmount: string,
  slippageBps: number,
  timeoutMs: number
): Promise<{ estimatedSolOut: number; priceImpactPct: number } | null> => {
  try {
    const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
    const baseUrl = process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag';
    const { data } = await axios.get(`${baseUrl}/swap/v1/quote`, {
      params: {
        inputMint: tokenMint,
        outputMint: NATIVE_MINT,
        amount: tokenAmount,
        slippageBps
      },
      timeout: timeoutMs
    });

    const outLamports = BigInt(data.otherAmountThreshold || '0');
    const priceImpactPct = parseFloat(data.priceImpactPct || '0');
    return {
      estimatedSolOut: Number(outLamports) / LAMPORTS_PER_SOL,
      priceImpactPct: priceImpactPct * 100 // as percent
    };
  } catch (e) {
    return null;
  }
};

/**
 * Auto take-profit: for each held position, check if token->SOL quote
 * yields net profit >= threshold. If yes, execute the sell.
 * @param _minProfitThresholdPct - minimum net profit % required to sell (e.g., 1.5 for 1.5%) - currently unused in simple heuristic
 * @param slippageBps - slippage in basis points
 * @param dryRun - if true, only preview and log, don't execute
 * @returns array of signatures for sells executed (empty in dry-run)
 */
export const checkAndTakeProfit = async (
  _minProfitThresholdPct: number,
  slippageBps: number,
  dryRun: boolean
): Promise<TradeResult[]> => {
  const positions = await getHeldPositions();
  const results: TradeResult[] = [];

  console.log(`Auto take-profit check: ${positions.length} positions found`);

  for (const pos of positions) {
    // Skip stablecoins or very small amounts
    const isStable = pos.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
    if (isStable || pos.uiAmount < 0.01) {
      console.log(`Skipping position ${pos.mint} (stable or small amount)`);
      continue;
    }

    console.log(`Checking position: ${pos.mint}, amount: ${pos.uiAmount}`);

    const preview = await previewTokenToSol(pos.mint, pos.amount, slippageBps, 8000);
    if (!preview) {
      console.log(`Failed to preview ${pos.mint} -> SOL quote, skipping`);
      continue;
    }

    const { estimatedSolOut, priceImpactPct } = preview;
    console.log(`Preview ${pos.mint} -> SOL: est ~${estimatedSolOut.toFixed(6)} SOL, impact ${priceImpactPct.toFixed(2)}%`);

    // **PROFIT-FOCUSED LOGIC**: Get entry price and current price to calculate ACTUAL profit
    const entryPrice = getEntryPrice(pos.mint);
    if (!entryPrice) {
      console.log(`No entry price tracked for ${pos.mint}, skipping take-profit`);
      continue;
    }

    // Fetch current price from Dexscreener
    let currentPrice = 0;
    try {
      const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${pos.mint}`, { timeout: 5000 });
      const pair = dexRes.data.pairs?.[0];
      currentPrice = pair?.priceUsd ? parseFloat(pair.priceUsd) : 0;
    } catch (e) {
      console.log(`Failed to fetch current price for ${pos.mint}, skipping`);
      continue;
    }

    if (currentPrice === 0) {
      console.log(`No price data for ${pos.mint}, skipping`);
      continue;
    }

    // Calculate actual profit percentage
    const profitPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    console.log(`Position ${pos.mint}: entry $${entryPrice.toFixed(6)}, current $${currentPrice.toFixed(6)}, profit ${profitPct.toFixed(2)}%`);

    // **REQUIRE REAL PROFIT**: Must beat fees (trading fees ~1-2% total) + minimum profit threshold
    // Using _minProfitThresholdPct (passed in) as the minimum required profit to sell
    const worthSelling = profitPct >= _minProfitThresholdPct && priceImpactPct <= 5 && estimatedSolOut >= 0.001;

    if (!worthSelling) {
      console.log(`Not selling ${pos.mint}: profit ${profitPct.toFixed(2)}% below threshold ${_minProfitThresholdPct}% (or impact too high)`);
      continue;
    }

    console.log(`Taking profit on ${pos.mint}: selling for ~${estimatedSolOut.toFixed(6)} SOL`);

    if (dryRun) {
      console.log(`[DRY-RUN] Would sell ${pos.mint} -> SOL`);
      continue;
    }

    try {
      // Get current price for P&L calculation
      const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${pos.mint}`, { timeout: 5000 });
      const pair = dexRes.data.pairs?.[0];
      const currentPrice = pair?.priceUsd ? parseFloat(pair.priceUsd) : 0;
      const entryPrice = getEntryPrice(pos.mint) || currentPrice;

      // Use executeSnipeSwap but with token as input and SOL as output
      // We need a variant that accepts inputMint; for now we'll call Jupiter directly here
      const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
      const baseUrl = process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag';
      const quoteRes = await axios.get(`${baseUrl}/swap/v1/quote`, {
        params: {
          inputMint: pos.mint,
          outputMint: NATIVE_MINT,
          amount: pos.amount,
          slippageBps
        },
        timeout: 10000
      });
      const quote = quoteRes.data;

      const swapRes = await axios.post(
        `${baseUrl}/swap/v1/swap`,
        {
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true
        },
        { timeout: 10000 }
      );

      const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
      const { VersionedTransaction } = await import('@solana/web3.js');
      const tx = VersionedTransaction.deserialize(swapTxBuf);
      tx.sign([wallet]);
      const sig = await rpc.sendTransaction(tx, { maxRetries: 3, skipPreflight: false });
      await rpc.confirmTransaction({
        signature: sig,
        blockhash: tx.message.recentBlockhash,
        lastValidBlockHeight: swapRes.data.lastValidBlockHeight
      });

      console.log(`Sold ${pos.mint} -> SOL, signature: ${sig}`);

      // Calculate P&L
      const exitValue = estimatedSolOut;
      const pnl = exitValue - (entryPrice * pos.uiAmount / currentPrice || exitValue * 0.1); // Rough estimate if no entry price
      const pnlPercent = entryPrice > 0 ? ((exitValue - (entryPrice * pos.uiAmount / currentPrice)) / (entryPrice * pos.uiAmount / currentPrice)) * 100 : 0;

      results.push({
        signature: sig,
        tokenAddress: pos.mint,
        tokenSymbol: pair?.baseToken?.symbol || 'UNKNOWN',
        amount: pos.uiAmount,
        exitPrice: currentPrice,
        exitValue: exitValue,
        pnl: pnl,
        pnlPercent: pnlPercent
      });
    } catch (e) {
      console.error(`Failed to sell ${pos.mint}:`, e instanceof Error ? e.message : e);
    }
  }

  return results;
};

/**
 * Check positions for stop loss and sell if price dropped below threshold.
 */
export const checkAndStopLoss = async (
  stopLossPct: number,
  slippageBps: number,
  dryRun: boolean
): Promise<TradeResult[]> => {
  const positions = await getHeldPositions();
  const results: TradeResult[] = [];

  console.log(`Auto stop-loss check: ${positions.length} positions found`);

  for (const pos of positions) {
    // Skip stablecoins or very small amounts
    const isStable = pos.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
    if (isStable || pos.uiAmount < 0.01) {
      console.log(`Skipping position ${pos.mint} (stable or small amount)`);
      continue;
    }

    const entryPrice = getEntryPrice(pos.mint);
    if (!entryPrice) {
      console.log(`No entry price for ${pos.mint}, skipping stop loss`);
      continue;
    }

    // Fetch current price
    try {
      const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${pos.mint}`, { timeout: 5000 });
      const pair = dexRes.data.pairs?.[0];
      if (!pair || !pair.priceUsd) {
        console.log(`No price data for ${pos.mint}`);
        continue;
      }
      const currentPrice = parseFloat(pair.priceUsd);
      const stopPrice = entryPrice * (1 - stopLossPct / 100);

      console.log(`Position ${pos.mint}: entry ${entryPrice.toFixed(6)}, current ${currentPrice.toFixed(6)}, stop at ${stopPrice.toFixed(6)}`);

      if (currentPrice >= stopPrice) {
        console.log(`Not stopping loss for ${pos.mint}: current price above stop level`);
        continue;
      }

      console.log(`Stop loss triggered for ${pos.mint}: selling at loss`);

      if (dryRun) {
        console.log(`[DRY-RUN] Would sell ${pos.mint} -> SOL for stop loss`);
        continue;
      }

      // Sell logic (same as take profit)
      const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
      const baseUrl = process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag';
      const quoteRes = await axios.get(`${baseUrl}/swap/v1/quote`, {
        params: {
          inputMint: pos.mint,
          outputMint: NATIVE_MINT,
          amount: pos.amount,
          slippageBps
        },
        timeout: 10000
      });
      const quote = quoteRes.data;

      const swapRes = await axios.post(
        `${baseUrl}/swap/v1/swap`,
        {
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true
        },
        { timeout: 10000 }
      );

      const swapTxBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
      const { VersionedTransaction } = await import('@solana/web3.js');
      const tx = VersionedTransaction.deserialize(swapTxBuf);
      tx.sign([wallet]);
      const sig = await rpc.sendTransaction(tx, { maxRetries: 3, skipPreflight: false });
      await rpc.confirmTransaction({
        signature: sig,
        blockhash: tx.message.recentBlockhash,
        lastValidBlockHeight: swapRes.data.lastValidBlockHeight
      });

      console.log(`Stop loss sold ${pos.mint} -> SOL, signature: ${sig}`);

      // Calculate P&L for stop loss
      const exitValue = parseFloat(quote.outAmount) / LAMPORTS_PER_SOL;
      const pnl = exitValue - (entryPrice * pos.uiAmount);
      const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

      results.push({
        signature: sig,
        tokenAddress: pos.mint,
        tokenSymbol: pair?.baseToken?.symbol || 'UNKNOWN',
        amount: pos.uiAmount,
        exitPrice: currentPrice,
        exitValue: exitValue,
        pnl: pnl,
        pnlPercent: pnlPercent
      });

      // Remove entry price after selling
      const prices = loadEntryPrices();
      delete prices[pos.mint];
      saveEntryPrices(prices);

    } catch (e) {
      console.error(`Failed stop loss check for ${pos.mint}:`, e instanceof Error ? e.message : e);
    }
  }

  return results;
};
