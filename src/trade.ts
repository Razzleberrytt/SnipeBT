import axios, { AxiosError } from 'axios';
import https from 'https';
import dns from 'dns';
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { rpc, wallet, CONSTANTS } from './legacy/config';
import { estimateSolTransactionFee } from './utils';

// Optional: nudge DNS servers; non-fatal if it fails
try {
  const DNS_SERVERS = (process.env.JUPITER_DNS_SERVERS || '1.1.1.1,1.0.0.1,8.8.8.8,8.8.4.4')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (DNS_SERVERS.length) dns.setServers(DNS_SERVERS);
} catch {}

// (Optional) A custom DNS lookup function could be added here if needed.

// HTTPS agent (use OS DNS now that lite-api resolves properly)
const httpsAgent = new https.Agent({ keepAlive: true });

// DNS-over-HTTPS fallback (Google then Cloudflare DoH) to resolve a hostname to an IP
async function resolveViaDoH(hostname: string): Promise<string | null> {
  try {
    const { data } = await axios.get('https://dns.google/resolve', {
      params: { name: hostname, type: 'A' },
      timeout: 5000,
      httpsAgent
    });
    const answers: any[] = data?.Answer || [];
    const a = answers.find((x: any) => x.type === 1 && x.data);
    if (a?.data) return String(a.data);

    const { data: data6 } = await axios.get('https://dns.google/resolve', {
      params: { name: hostname, type: 'AAAA' },
      timeout: 5000,
      httpsAgent
    });
    const answers6: any[] = data6?.Answer || [];
    const a6 = answers6.find((x: any) => x.type === 28 && x.data);
    if (a6?.data) return String(a6.data);
  } catch {}
  // Try Cloudflare DoH JSON endpoint
  try {
    const { data } = await axios.get('https://cloudflare-dns.com/dns-query', {
      params: { name: hostname, type: 'A' },
      headers: { accept: 'application/dns-json' },
      timeout: 5000,
      httpsAgent
    });
    const answers: any[] = data?.Answer || [];
    const a = answers.find((x: any) => x.type === 1 && x.data);
    if (a?.data) return String(a.data);

    const { data: data6 } = await axios.get('https://cloudflare-dns.com/dns-query', {
      params: { name: hostname, type: 'AAAA' },
      headers: { accept: 'application/dns-json' },
      timeout: 5000,
      httpsAgent
    });
    const answers6: any[] = data6?.Answer || [];
    const a6 = answers6.find((x: any) => x.type === 28 && x.data);
    if (a6?.data) return String(a6.data);
  } catch {}
  // Try Cloudflare DoH by direct IP (1.1.1.1) to avoid any hostname resolution issues
  try {
    const cfAgent = new https.Agent({ keepAlive: true, servername: 'one.one.one.one' });
    const { data } = await axios.get('https://1.1.1.1/dns-query', {
      params: { name: hostname, type: 'A' },
      headers: { accept: 'application/dns-json', Host: 'one.one.one.one' },
      timeout: 5000,
      httpsAgent: cfAgent
    });
    const answers: any[] = data?.Answer || [];
    const a = answers.find((x: any) => x.type === 1 && x.data);
    if (a?.data) return String(a.data);

    const { data: data6 } = await axios.get('https://1.1.1.1/dns-query', {
      params: { name: hostname, type: 'AAAA' },
      headers: { accept: 'application/dns-json', Host: 'one.one.one.one' },
      timeout: 5000,
      httpsAgent: cfAgent
    });
    const answers6: any[] = data6?.Answer || [];
    const a6 = answers6.find((x: any) => x.type === 28 && x.data);
    if (a6?.data) return String(a6.data);
  } catch {}
  return null;
}

// Define types for Jupiter API responses
interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null | { amount: string; feeBps: number };
  priceImpactPct: string;
  routePlan: Array<any>;
  contextSlot: number;
  timeTaken: number;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

// Configuration interface
interface SnipeConfig {
  slippageBps: number;
  defaultAmountInSol: number;
  maxRetries: number;
  timeoutMs: number;
  maxPriceImpactBps: number;     // Maximum allowed price impact in basis points
  minBalanceSOL: number;         // Minimum SOL balance to maintain
  maxTransactionsPerMinute: number; // Rate limiting
  enableSafetyChecks: boolean;   // Enable additional safety checks
  dryRun?: boolean;              // If true, simulate swap without sending transaction
}

// Default configuration for live environment
const DEFAULT_CONFIG: SnipeConfig = {
  slippageBps: 50,               // Reduced to 0.5% for tighter execution
  defaultAmountInSol: 0.005,     // Smaller default amount for more trades
  maxRetries: 3,
  timeoutMs: 10000,              // Reduced to 10 seconds for faster response
  maxPriceImpactBps: 300,        // Max 3% price impact for better execution
  minBalanceSOL: 0.01,           // Reduced minimum balance for more trading capital
  maxTransactionsPerMinute: 60,   // Increased limit for more opportunities
  enableSafetyChecks: true       // Keep safety checks enabled
};

// Transaction tracking for rate limiting
const transactionHistory: number[] = [];
const MAX_HISTORY_SIZE = 100;

let raydium: Raydium;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Note: fee estimation is delegated to `estimateSolTransactionFee` in `src/utils.ts`

export const initRaydium = async () => {
  try {
    if (raydium) return raydium;
    
    raydium = await Raydium.load({
      owner: wallet,
      connection: rpc,
      cluster: process.env.RPC_URL?.includes('devnet') ? 'devnet' : 'mainnet',
      disableFeatureCheck: true,
    });
    return raydium;
  } catch (error) {
    throw new Error(`Failed to initialize Raydium: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

export const executeSnipeSwap = async (
  outputMint: string, 
  amountInSol: number = DEFAULT_CONFIG.defaultAmountInSol,
  config: Partial<SnipeConfig> = {}
) => {
  // Merge default config with provided config
  const finalConfig: SnipeConfig = { ...DEFAULT_CONFIG, ...config };

  // Validate input parameters
  try {
    new PublicKey(outputMint); // Validate outputMint is a valid public key
  } catch (error) {
    throw new Error('Invalid output mint address');
  }

  if (amountInSol <= 0) {
    throw new Error('Amount must be greater than 0');
  }

  const amountInLamports = Math.floor(amountInSol * LAMPORTS_PER_SOL);

  // Rate limiting check
  const now = Date.now();
  transactionHistory.push(now);
  while (transactionHistory.length > MAX_HISTORY_SIZE) {
    transactionHistory.shift();
  }
  
  const recentTransactions = transactionHistory.filter(
    time => now - time < 60000 // Last minute
  ).length;

  if (recentTransactions >= finalConfig.maxTransactionsPerMinute) {
    throw new Error(`Rate limit exceeded: ${finalConfig.maxTransactionsPerMinute} transactions per minute`);
  }

  // Balance check
  const balance = await rpc.getBalance(wallet.publicKey);
  const balanceInSOL = balance / LAMPORTS_PER_SOL;
  
  if (balanceInSOL < finalConfig.minBalanceSOL + amountInSol) {
    throw new Error(`Insufficient balance. Required: ${(finalConfig.minBalanceSOL + amountInSol).toFixed(4)} SOL, Current: ${balanceInSOL.toFixed(4)} SOL`);
  }

  await initRaydium();

  // Function to handle retries with exponential backoff
  const withRetry = async <T>(
    operation: () => Promise<T>,
    retryCount: number = 0
  ): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (retryCount >= finalConfig.maxRetries) throw error;
      
      const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 10000);
      await sleep(backoffMs);
      
      return withRetry(operation, retryCount + 1);
    }
  };

  try {
    // Get Jupiter quote with timeout and retry
    const getQuote = async () => {
      const host = 'lite-api.jup.ag';
      const directIp = process.env.JUPITER_QUOTE_IP;
      if (directIp) {
        const response = await axios.get<JupiterQuoteResponse>(
          `https://${directIp}/swap/v1/quote`,
          {
            params: {
              inputMint: CONSTANTS.NATIVE_MINT.toBase58(),
              outputMint,
              amount: amountInLamports.toString(),
              slippageBps: finalConfig.slippageBps
            },
            timeout: finalConfig.timeoutMs,
            httpsAgent: new https.Agent({ servername: host, keepAlive: true }),
            headers: { Host: host }
          }
        );
        return response.data;
      }
      const baseUrl = process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag';
      const response = await axios.get<JupiterQuoteResponse>(
        `${baseUrl}/swap/v1/quote`,
        {
          params: {
            inputMint: CONSTANTS.NATIVE_MINT.toBase58(),
            outputMint,
            amount: amountInLamports.toString(),
            slippageBps: finalConfig.slippageBps
          },
          timeout: finalConfig.timeoutMs,
          httpsAgent
        }
      );
      return response.data;
    };


    let quote: JupiterQuoteResponse | null = null;
    try {
      quote = await withRetry(getQuote);
    } catch (e: any) {
      // If network/DNS error and we're in dry-run, synthesize a quote so we can continue testing
      const msg = typeof e?.message === 'string' ? e.message : '';
      const isDns = msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN') || msg.includes('getaddrinfo') || msg.includes('ENODATA');
      if (finalConfig.dryRun && isDns) {
        console.warn('Jupiter quote unreachable (DNS). Proceeding with simulated dry-run metrics.');
        const simulatedPriceImpact = 0.01; // 1%
        const estimatedFeeSol = await estimateSolTransactionFee();
        const priceImpactLossSol = amountInSol * simulatedPriceImpact;
        const totalCostSol = amountInSol + estimatedFeeSol + priceImpactLossSol;
        const costPercent = (estimatedFeeSol + priceImpactLossSol) / amountInSol;
        return {
          success: true,
          dryRun: true,
          inputAmount: `${amountInSol} SOL`,
          outputMint,
          quote: null,
          estimatedFeeSol,
          priceImpactPct: simulatedPriceImpact * 100,
          priceImpactLossSol,
          totalCostSol,
          costPercent,
          simulated: true,
          note: 'Synthetic dry-run due to Jupiter DNS error',
          timestamp: new Date().toISOString(),
        } as any;
      }
      // Live mode: try DoH resolve + direct IP request as a last resort
      if (!finalConfig.dryRun && isDns) {
        const host = 'lite-api.jup.ag';
        const ip = await resolveViaDoH(host);
        if (ip) {
          try {
            const direct = await axios.get<JupiterQuoteResponse>(
              `https://${ip}/swap/v1/quote`,
              {
                params: {
                  inputMint: CONSTANTS.NATIVE_MINT.toBase58(),
                  outputMint,
                  amount: amountInLamports.toString(),
                  slippageBps: finalConfig.slippageBps
                },
                timeout: finalConfig.timeoutMs,
                httpsAgent: new https.Agent({ servername: host, keepAlive: true }),
                headers: { Host: host }
              }
            );
            quote = direct.data;
          } catch {
            throw e;
          }
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
  if (!quote) throw new Error('Failed to get quote');

  // Safety checks for quote
  const priceImpact = parseFloat(quote.priceImpactPct);
    if (priceImpact * 100 > finalConfig.maxPriceImpactBps) {
      throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}% (max: ${(finalConfig.maxPriceImpactBps / 100).toFixed(2)}%)`);
    }

    // Additional safety checks if enabled
    if (finalConfig.enableSafetyChecks) {
      // Check if route plan exists and is valid
      if (!quote.routePlan || quote.routePlan.length === 0) {
        throw new Error('Invalid route plan received from Jupiter');
      }

      // Validate output amount
      if (!quote.otherAmountThreshold || BigInt(quote.otherAmountThreshold) <= BigInt(0)) {
        throw new Error('Invalid output amount in quote');
      }
    }

    console.log('Trade preparation:', {
      priceImpact: `${priceImpact.toFixed(2)}%`,
      inputAmount: `${amountInSol} SOL`,
      expectedOutput: quote.otherAmountThreshold,
      route: quote.routePlan.length + ' steps'
    });

    // If dryRun is requested, return quote and estimated fees without sending transaction
    if (finalConfig.dryRun) {
      const estimatedFeeSol = await estimateSolTransactionFee();
      const priceImpact = parseFloat(quote.priceImpactPct); // fractional (e.g., 0.01)
      const priceImpactLossSol = amountInSol * priceImpact; // rough SOL-equivalent of slippage
      const totalCostSol = amountInSol + estimatedFeeSol + priceImpactLossSol; // what this trade effectively costs now
      const costPercent = (estimatedFeeSol + priceImpactLossSol) / amountInSol; // percent of input lost to fees+impact

      return {
        success: true,
        dryRun: true,
        inputAmount: `${amountInSol} SOL`,
        outputMint,
        quote: quote,
        estimatedFeeSol,
        priceImpactPct: priceImpact * 100, // expose as percent
        priceImpactLossSol,
        totalCostSol,
        costPercent,
        timestamp: new Date().toISOString(),
      } as any;
    }

    // Get swap transaction (with DNS fallback similar to quote)
    const getSwapTx = async () => {
      const host = 'lite-api.jup.ag';
      const directIp = process.env.JUPITER_SWAP_IP || process.env.JUPITER_QUOTE_IP;
      if (directIp) {
        const response = await axios.post<JupiterSwapResponse>(
          `https://${directIp}/swap/v1/swap`,
          {
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
          },
          {
            timeout: finalConfig.timeoutMs,
            httpsAgent: new https.Agent({ servername: host, keepAlive: true }),
            headers: { Host: host }
          }
        );
        return response.data;
      }
      const baseUrlSwap = process.env.JUPITER_SWAP_URL || 'https://lite-api.jup.ag';
      const response = await axios.post<JupiterSwapResponse>(
        `${baseUrlSwap}/swap/v1/swap`,
        {
          quoteResponse: quote,
          userPublicKey: wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        },
        {
          timeout: finalConfig.timeoutMs,
          httpsAgent
        }
      );
      return response.data;
    };


    let swapTx: JupiterSwapResponse | null = null;
    try {
      swapTx = await withRetry(getSwapTx);
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : '';
      const isDns = msg.includes('ENOTFOUND') || msg.includes('EAI_AGAIN') || msg.includes('getaddrinfo') || msg.includes('ENODATA');
      if (!finalConfig.dryRun && isDns) {
        const host = 'lite-api.jup.ag';
        const ip = await resolveViaDoH(host);
        if (ip) {
          try {
            const direct = await axios.post<JupiterSwapResponse>(
              `https://${ip}/swap/v1/swap`,
              {
                quoteResponse: quote,
                userPublicKey: wallet.publicKey.toBase58(),
                wrapAndUnwrapSol: true,
              },
              {
                timeout: finalConfig.timeoutMs,
                httpsAgent: new https.Agent({ servername: host, keepAlive: true }),
                headers: { Host: host }
              }
            );
            swapTx = direct.data;
          } catch {
            throw e;
          }
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }

    // Deserialize and process the swap transaction
    if (!swapTx) throw new Error('Failed to get swap transaction');
    const swapTransactionBuf = Buffer.from(swapTx.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    // Sign the transaction
    transaction.sign([wallet]);

    // Send and confirm transaction with enhanced monitoring
    const signature = await withRetry(async () => {
      // Pre-flight check (light): ensure we can fetch a blockhash; rely on Jupiter-provided blockhash for validity
      if (finalConfig.enableSafetyChecks) {
        await rpc.getLatestBlockhash();
      }

      console.log('Sending transaction...');
      const startTime = Date.now();
      
      const sig = await rpc.sendTransaction(transaction, {
        maxRetries: 3,
        skipPreflight: false  // Enable preflight for live environment
      });
      
      console.log(`Transaction sent (${Date.now() - startTime}ms): ${sig}`);
      
      const confirmation = await rpc.confirmTransaction({
        signature: sig,
        blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight: swapTx.lastValidBlockHeight
      });

      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      // Post-transaction balance check
      const newBalance = await rpc.getBalance(wallet.publicKey);
      console.log('Balance after trade:', (newBalance / LAMPORTS_PER_SOL).toFixed(4), 'SOL');

      return sig;
    });

    const executionResult = {
      success: true,
      signature,
      inputAmount: `${amountInSol} SOL`,
      outputMint,
      slippage: `${finalConfig.slippageBps / 100}%`,
      timestamp: new Date().toISOString(),
      balanceAfter: (await rpc.getBalance(wallet.publicKey) / LAMPORTS_PER_SOL).toFixed(4)
    };

    console.log('Trade executed successfully:', executionResult);

    return executionResult;
  } catch (error) {
    const errorDetails = {
      success: false,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
      inputAmount: `${amountInSol} SOL`,
      outputMint,
      balanceSOL: (await rpc.getBalance(wallet.publicKey) / LAMPORTS_PER_SOL).toFixed(4)
    };

    console.error('Trade execution failed:', errorDetails);

    // Log detailed Jupiter API error if available
    if (error instanceof AxiosError && error.response) {
      console.error('Jupiter API Response:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
        requestParams: {
          inputMint: CONSTANTS.NATIVE_MINT.toBase58(),
          outputMint,
          amount: Math.floor(amountInSol * LAMPORTS_PER_SOL).toString(),
          slippageBps: finalConfig.slippageBps
        }
      });
      throw new Error(`Jupiter API error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
    }

    if (error instanceof AxiosError) {
      throw new Error(`Jupiter API error: ${error.message}`);
    }
    throw error;
  }
};

// Preview a two-leg round trip SOL -> token -> SOL using two quotes
export const previewRoundTrip = async (
  outputMint: string,
  amountInSol: number,
  slippageBps: number,
  timeoutMs: number
) => {
  const amountInLamports = Math.floor(amountInSol * LAMPORTS_PER_SOL);
  // First leg: SOL -> token
  const quote1 = await axios.get<JupiterQuoteResponse>(
    `${process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag'}/swap/v1/quote`,
    {
      params: {
        inputMint: CONSTANTS.NATIVE_MINT.toBase58(),
        outputMint,
        amount: amountInLamports.toString(),
        slippageBps
      },
      timeout: timeoutMs,
      httpsAgent
    }
  ).then(r => r.data);

  // Second leg (estimate): token -> SOL, use conservative otherAmountThreshold from leg1
  const thresholdToken = quote1.otherAmountThreshold;
  const quote2 = await axios.get<JupiterQuoteResponse>(
    `${process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag'}/swap/v1/quote`,
    {
      params: {
        inputMint: outputMint,
        outputMint: CONSTANTS.NATIVE_MINT.toBase58(),
        amount: thresholdToken,
        slippageBps
      },
      timeout: timeoutMs,
      httpsAgent
    }
  ).then(r => r.data);

  const estFinalLamports = BigInt(quote2.otherAmountThreshold);
  return {
    quoteBuy: quote1,
    quoteSell: quote2,
    inputLamports: BigInt(amountInLamports),
    estFinalLamports
  };
};

// Execute SOL -> token -> SOL, only if preview indicates net-positive beyond threshold
export const executeRoundTripSwap = async (
  outputMint: string,
  amountInSol: number,
  config: Partial<SnipeConfig> & { minProfitThresholdPct?: number, dryRun?: boolean } = {}
) => {
  const finalConfig: SnipeConfig = { ...DEFAULT_CONFIG, ...config };
  const minProfitPct = config.minProfitThresholdPct ?? 1.0; // default 1%

  // Preview profitability
  const preview = await previewRoundTrip(outputMint, amountInSol, finalConfig.slippageBps, finalConfig.timeoutMs);
  const inLamports = preview.inputLamports;
  const outLamports = preview.estFinalLamports;
  const netPct = Number(outLamports - inLamports) / Number(inLamports) * 100;

  console.log(`Round-trip preview: in=${(Number(inLamports)/LAMPORTS_PER_SOL).toFixed(6)} SOL -> est out=${(Number(outLamports)/LAMPORTS_PER_SOL).toFixed(6)} SOL, net=${netPct.toFixed(2)}%`);

  if (netPct < minProfitPct) {
    console.log(`Skipping round-trip: net ${netPct.toFixed(2)}% < min ${minProfitPct.toFixed(2)}%`);
    return { success: false, reason: 'Insufficient round-trip profit', dryRun: true } as any;
  }

  if (config.dryRun) {
    return {
      success: true,
      dryRun: true,
      inputAmount: `${amountInSol} SOL`,
      outputMint,
      previewNetPct: netPct
    } as any;
  }

  // Execute leg 1: SOL -> token
  const leg1 = await executeSnipeSwap(outputMint, amountInSol, { ...config, dryRun: false });
  if (!leg1?.success) {
    throw new Error('Leg 1 failed');
  }

  // Determine received token amount by checking token balance
  const tokenMint = new PublicKey(outputMint);
  const tokenAccounts = await rpc.getTokenAccountsByOwner(wallet.publicKey, { mint: tokenMint });
  let tokenAmount: bigint = BigInt(0);
  if (tokenAccounts.value.length > 0) {
    const info = await rpc.getParsedAccountInfo(tokenAccounts.value[0].pubkey);
    const parsed: any = info.value?.data;
    const amtStr = parsed?.parsed?.info?.tokenAmount?.amount || '0';
    tokenAmount = BigInt(amtStr);
  }
  if (tokenAmount <= BigInt(0)) {
    throw new Error('Failed to detect received token amount after leg 1');
  }

  // Execute leg 2: token -> SOL using fresh quote
  const freshQuote = await axios.get<JupiterQuoteResponse>(
    `${process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag'}/swap/v1/quote`,
    {
      params: {
        inputMint: outputMint,
        outputMint: CONSTANTS.NATIVE_MINT.toBase58(),
        amount: tokenAmount.toString(),
        slippageBps: finalConfig.slippageBps
      },
      timeout: finalConfig.timeoutMs,
      httpsAgent
    }
  ).then(r => r.data);

  // Build swap for leg 2
  const swap2 = await axios.post<JupiterSwapResponse>(
    `${process.env.JUPITER_SWAP_URL || 'https://lite-api.jup.ag'}/swap/v1/swap`,
    {
      quoteResponse: freshQuote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    },
    {
      timeout: finalConfig.timeoutMs,
      httpsAgent
    }
  ).then(r => r.data);

  const swapTxBuf2 = Buffer.from(swap2.swapTransaction, 'base64');
  const tx2 = VersionedTransaction.deserialize(swapTxBuf2);
  tx2.sign([wallet]);
  const sig2 = await rpc.sendTransaction(tx2, { maxRetries: 3, skipPreflight: false });
  await rpc.confirmTransaction({ signature: sig2, blockhash: tx2.message.recentBlockhash, lastValidBlockHeight: swap2.lastValidBlockHeight });

  const finalBal = await rpc.getBalance(wallet.publicKey);
  return {
    success: true,
    leg1Signature: leg1.signature,
    leg2Signature: sig2,
    finalBalanceSol: (finalBal / LAMPORTS_PER_SOL).toFixed(6)
  };
}

/**
 * Fetch the decimals for a given SPL token mint.
 * @param mintAddress Token mint address (string or PublicKey)
 * @returns Number of decimals for the token
 */
export async function fetchMintDecimals(mintAddress: string | PublicKey): Promise<number> {
  const mintPubkey = typeof mintAddress === 'string' ? new PublicKey(mintAddress) : mintAddress;
  const mintInfo = await getMint(rpc, mintPubkey);
  return mintInfo.decimals;
}

/**
 * Execute a swap using a non-SOL token as input.
 * @param inputMint Address of the input token mint
 * @param inputAmount Amount of input token (in base units)
 * @param outputMint Address of the output token mint
 * @param slippageBps Slippage tolerance in basis points
 * @param dryRun If true, only preview the swap
 * @param timeoutMs Request timeout
 * @returns Transaction signature and final balance
 */
export async function executeMultiInputSwap(
  inputMint: string,
  inputAmount: bigint,
  outputMint: string,
  slippageBps: number = 50,
  dryRun: boolean = false,
  timeoutMs: number = 20000
): Promise<{ signature: string; finalBalanceSol: string }> {
  // Get quote
  const quote = await axios.get<JupiterQuoteResponse>(
    `${process.env.JUPITER_QUOTE_URL || 'https://lite-api.jup.ag'}/swap/v1/quote`,
    {
      params: {
        inputMint,
        outputMint,
        amount: inputAmount.toString(),
        slippageBps
      },
      timeout: timeoutMs,
      httpsAgent
    }
  ).then(r => r.data);

  const { priceImpactPct } = quote;
  const impact = typeof priceImpactPct === 'number' && Number.isFinite(priceImpactPct) ? priceImpactPct : 0;
  
  console.log(`Multi-input quote: ${inputMint.slice(0, 8)}... → ${outputMint.slice(0, 8)}..., impact ${impact.toFixed(2)}%`);

  if (dryRun) {
    console.log('[DRY RUN] Multi-input swap skipped.');
    return { signature: 'DRY_RUN', finalBalanceSol: '0.000000' };
  }

  // Build swap transaction
  const swap = await axios.post<JupiterSwapResponse>(
    `${process.env.JUPITER_SWAP_URL || 'https://lite-api.jup.ag'}/swap/v1/swap`,
    {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    },
    {
      timeout: timeoutMs,
      httpsAgent
    }
  ).then(r => r.data);

  const swapTxBuf = Buffer.from(swap.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(swapTxBuf);
  tx.sign([wallet]);

  const sig = await rpc.sendTransaction(tx, { maxRetries: 3, skipPreflight: false });
  await rpc.confirmTransaction({
    signature: sig,
    blockhash: tx.message.recentBlockhash,
    lastValidBlockHeight: swap.lastValidBlockHeight
  });

  const finalBal = await rpc.getBalance(wallet.publicKey);
  return {
    signature: sig,
    finalBalanceSol: (finalBal / LAMPORTS_PER_SOL).toFixed(6)
  };
};