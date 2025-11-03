import { randomUUID } from "crypto";
import { insertTrade } from "../db";
import { loadConfig } from "../config";

function sleep(ms:number){ return new Promise(r=>setTimeout(r,ms)); }

export async function submitTrade(params: {
  side: "BUY"|"SELL"; mint: string; price: number; size: number;
  serializeAndSend: () => Promise<{ txSig?: string; error?: string }>;
}) {
  const id = randomUUID();
  const cfg = loadConfig();
  let attempt = 0; const max = 5;
  while (attempt < max) {
    attempt++;
    const r = await params.serializeAndSend();
    if (r.txSig) {
      insertTrade({
        id, position_id: null, side: params.side, mint: params.mint,
        price: params.price, size: params.size, tx_sig: r.txSig,
        route: null, fee_lamports: null, created_at: Date.now()
      });
      return { ok: true, id, txSig: r.txSig };
    }
    await sleep(300 * attempt + Math.floor(Math.random()*200));
  }
  insertTrade({
    id, position_id: null, side: params.side, mint: params.mint,
    price: params.price, size: params.size, tx_sig: null,
    route: null, fee_lamports: null, created_at: Date.now()
  });
  if (!cfg.DRY_RUN) { /* consider circuit breaker elsewhere */ }
  return { ok: false, id, error: "submit_failed" };
}
