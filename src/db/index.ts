import path from "path"; import fs from "fs";
import { loadConfig } from "../config";
import { opt } from "../vendor/resolve";
import { JsonDB } from "./json";
export type TradeRow = { id:string; position_id:string|null; side:"BUY"|"SELL"; mint:string; price:number; size:number; tx_sig:string|null; route:string|null; fee_lamports:number|null; created_at:number; };
type DBApi = { insertTrade(t:TradeRow): void; };
let api: DBApi | null = null;
export function getDB(): DBApi {
  if (api) return api;
  const cfg = loadConfig(); const dir = path.resolve(cfg.DATA_DIR); if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
  const Better = opt<any>("better-sqlite3");
  if (Better) {
    const db = new Better(path.join(dir,"state.db")); db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY, position_id TEXT, side TEXT, mint TEXT, price REAL, size REAL, tx_sig TEXT, route TEXT, fee_lamports INTEGER, created_at INTEGER);`);
    api = {
      insertTrade(t){ db.prepare(`INSERT INTO trades(id,position_id,side,mint,price,size,tx_sig,route,fee_lamports,created_at) VALUES(@id,@position_id,@side,@mint,@price,@size,@tx_sig,@route,@fee_lamports,@created_at)`).run(t); }
    };
  } else {
    api = new JsonDB(dir);
  }
  return api!;
}
export function insertTrade(t:TradeRow){ return getDB().insertTrade(t); }
