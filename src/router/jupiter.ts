import { loadConfig } from "../config";
import { fetchInput as fetch } from "../vendor/fetch";
export type QuoteReq = { inputMint:string; outputMint:string; amount:string; slippageBps:number; };
export type QuoteRes = { data?: unknown; routePlan?: unknown; error?: string };
export async function getQuote(q: QuoteReq): Promise<QuoteRes> {
  const { JUPITER_BASE_URL } = loadConfig();
  const url = new URL(`${JUPITER_BASE_URL}/quote`);
  Object.entries(q).forEach(([k,v])=> url.searchParams.set(k,String(v)));
  const r = await fetch(url.toString());
  if (!("ok" in r) || !(r as any).ok) return { error: "quote_http_error" };
  return await (r as any).json() as QuoteRes;
}
// TODO: implement build/serialize swap tx via Jupiter API
