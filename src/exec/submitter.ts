import { uuidv4 } from "../vendor/uuid";
import { insertTrade } from "../db";
import { tradesSubmitted, tradesConfirmed } from "../telemetry/metrics";
function sleep(ms:number){ return new Promise(r=>setTimeout(r,ms)); }
export async function submitTrade(params:{ side:"BUY"|"SELL"; mint:string; price:number; size:number; serializeAndSend:()=>Promise<{txSig?:string; error?:string}>; }){
  const id = uuidv4(); let attempt=0; const max=5;
  while(attempt<max){ attempt++; tradesSubmitted.inc(); const r=await params.serializeAndSend(); if(r.txSig){ tradesConfirmed.inc(); insertTrade({ id, position_id:null, side:params.side, mint:params.mint, price:params.price, size:params.size, tx_sig:r.txSig, route:null, fee_lamports:null, created_at:Date.now() }); return { ok:true, id, txSig:r.txSig }; } await sleep(300*attempt + Math.floor(Math.random()*200)); }
  insertTrade({ id, position_id:null, side:params.side, mint:params.mint, price:params.price, size:params.size, tx_sig:null, route:null, fee_lamports:null, created_at:Date.now() }); return { ok:false, id, error:"submit_failed" };
}
