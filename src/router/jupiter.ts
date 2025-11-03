import fetch from "node-fetch";
import { loadConfig } from "../config";

export type QuoteReq = { inputMint: string; outputMint: string; amount: string; slippageBps: number; };
export type QuoteRes = { data?: unknown; routePlan?: unknown; error?: string };

export async function getQuote(q: QuoteReq): Promise<QuoteRes> {
  const { JUPITER_BASE_URL } = loadConfig();
  const url = new URL(`${JUPITER_BASE_URL}/quote`);
  Object.entries({ ...q }).forEach(([k,v])=> url.searchParams.set(k,String(v)));
  const r = await fetch(url.toString());
  if (!r.ok) return { error: `quote_http_${r.status}` };
  return await r.json() as QuoteRes;
}

// NOTE: Building/serializing transactions may require a specific endpoint; implement later.
// Provide placeholder to keep the call site clean.
export async function buildSwapTx(/* params */): Promise<{ tx?: string; error?: string }> {
  return { error: "not_implemented" };
}
