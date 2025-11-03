#!/usr/bin/env ts-node
import readline from 'readline';
import { loadConfig } from './config';
import { executeSnipeSwap } from './trade';
import { initializeAndLog, rpc, wallet } from './legacy/config';
import { estimateExpectedUpside } from './utils';

loadConfig();

const ARG = (name: string) => {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : '';
};

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise<string>((resolve) => rl.question(question, (a) => resolve(a || '')));
  rl.close();
  return ans.trim();
}

async function main() {
  const forced = ARG('--token') || process.env.FORCED_TOKEN || '';
  if (!forced) {
    console.error('Usage: ts-node src/oneTrade.ts --token <MINT> [--amount-sol 0.005] [--slippage-bps 50]');
    process.exit(1);
  }
  const amount = Number(ARG('--amount-sol')) || Number(process.env.AMOUNT_SOL) || 0.005;
  const slippage = Number(ARG('--slippage-bps')) || Number(process.env.SLIPPAGE_BPS) || 50;

  console.log('Initializing configuration...');
  await initializeAndLog();

  const bal = await rpc.getBalance(wallet.publicKey).catch(() => 0);
  console.log(`Wallet balance: ${(bal / 1e9).toFixed(6)} SOL`);
  if (bal / 1e9 < amount + 0.01) {
    console.error('Insufficient balance for the requested amount + safety buffer. Aborting.');
    process.exit(1);
  }

  console.log('\n--- Dry-run probe ---');
  const probe = await executeSnipeSwap(forced, amount, { slippageBps: slippage, dryRun: true, timeoutMs: 10000 });
  console.log('Probe result:', probe);

  const expectedUpside = await estimateExpectedUpside(forced).catch(() => 0);
  const costPercent = probe?.costPercent ?? 0;
  const netExpected = expectedUpside - costPercent;
  console.log(`Estimated upside: ${(expectedUpside * 100).toFixed(2)}% | Estimated cost: ${(costPercent * 100).toFixed(2)}% | Net: ${(netExpected * 100).toFixed(2)}%`);

  const bypass = process.argv.includes('--confirm-live') || process.argv.includes('--yes') || process.env.CONFIRM_LIVE === 'true';
  if (!bypass) {
    const proceed = await prompt('\nType CONFIRM to execute a LIVE trade with these parameters (or anything else to abort): ');
    if (proceed !== 'CONFIRM') {
      console.log('Aborted by user. No on-chain transaction will be sent.');
      process.exit(0);
    }
  } else {
    console.log('Bypass flag detected (--confirm-live/--yes or CONFIRM_LIVE=true) — proceeding without interactive prompt.');
  }

  console.log('\nExecuting LIVE trade...');
  try {
    const res = await executeSnipeSwap(forced, amount, { slippageBps: slippage, dryRun: false, timeoutMs: 15000 });
    console.log('Live execution result:', res);
  } catch (err: any) {
    console.error('Live execution failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('oneTrade error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
