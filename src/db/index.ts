import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { loadConfig } from "../config";

export type TradeRow = {
  id: string; position_id: string | null; side: "BUY"|"SELL";
  mint: string; price: number; size: number; tx_sig: string | null;
  route: string | null; fee_lamports: number | null; created_at: number;
};

let db: Database.Database;

export function getDB() {
  if (db) return db;
  const cfg = loadConfig();
  const dir = path.resolve(cfg.DATA_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "state.db");
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades(
      id TEXT PRIMARY KEY, position_id TEXT, side TEXT, mint TEXT,
      price REAL, size REAL, tx_sig TEXT, route TEXT, fee_lamports INTEGER, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS positions(
      id TEXT PRIMARY KEY, mint TEXT, entry_price REAL, size REAL, status TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS health(
      id TEXT PRIMARY KEY, component TEXT, status TEXT, last_ok INTEGER, details TEXT
    );
  `);
  return db;
}

export function insertTrade(t: TradeRow) {
  const stmt = getDB().prepare(
    `INSERT INTO trades(id,position_id,side,mint,price,size,tx_sig,route,fee_lamports,created_at)
     VALUES(@id,@position_id,@side,@mint,@price,@size,@tx_sig,@route,@fee_lamports,@created_at)`
  );
  stmt.run(t);
}
