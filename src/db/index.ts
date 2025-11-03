import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { getConfig } from '../config';

export type DatabaseConnection = Database;

let instance: DatabaseConnection | null = null;

const getSchemaSql = (): string => {
  const schemaPath = path.join(__dirname, 'schema.sql');
  return fs.readFileSync(schemaPath, 'utf8');
};

const ensureColumn = (db: DatabaseConnection, table: string, column: string, definition: string) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  const exists = columns.some((col) => col.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

const ensureDatabase = (): Database => {
  if (instance) {
    return instance;
  }

  const { dataDir } = getConfig();
  const dbPath = path.join(dataDir, 'snipebt.sqlite');

  instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');

  const schema = getSchemaSql();
  instance.exec(schema);
  ensureColumn(instance, 'trades', 'status', "TEXT NOT NULL DEFAULT 'pending'");

  return instance;
};

export const getDb = (): DatabaseConnection => ensureDatabase();

export const withDb = <T>(handler: (db: DatabaseConnection) => T): T => handler(ensureDatabase());

export interface PositionUpsert {
  id?: string;
  mint: string;
  entryPrice?: number | null;
  size?: number | null;
  status?: string;
  createdAt?: number;
}

export interface PositionRecord {
  id: string;
  mint: string;
  entryPrice: number | null;
  size: number | null;
  status: string;
  createdAt: number;
}

export const upsertPosition = (input: PositionUpsert): void => {
  const db = ensureDatabase();
  const id = input.id ?? input.mint;
  const createdAt = input.createdAt ?? Date.now();
  const status = input.status ?? 'open';
  const stmt = db.prepare(
    `INSERT INTO positions (id, mint, entry_price, size, status, created_at)
     VALUES (@id, @mint, @entryPrice, @size, @status, @createdAt)
     ON CONFLICT(id) DO UPDATE SET
       mint = excluded.mint,
       entry_price = excluded.entry_price,
       size = COALESCE(excluded.size, positions.size),
       status = excluded.status`
  );

  stmt.run({
    id,
    mint: input.mint,
    entryPrice: input.entryPrice ?? null,
    size: input.size ?? null,
    status,
    createdAt
  });
};

export const getPositionByMint = (mint: string): PositionRecord | null => {
  const db = ensureDatabase();
  const row = db
    .prepare(
      `SELECT id, mint, entry_price AS entryPrice, size, status, created_at AS createdAt FROM positions WHERE mint = ? LIMIT 1`
    )
    .get(mint) as PositionRecord | undefined;
  return row ?? null;
};

export const getEntryPriceForMint = (mint: string): number | null => {
  const db = ensureDatabase();
  const row = db.prepare('SELECT entry_price FROM positions WHERE mint = ? LIMIT 1').get(mint) as
    | { entry_price: number | null }
    | undefined;
  return row?.entry_price ?? null;
};

export const setEntryPriceForMint = (mint: string, price: number): void => {
  upsertPosition({
    mint,
    entryPrice: price,
    status: 'open'
  });
};

export interface TradeInsert {
  id?: string;
  positionId?: string | null;
  symbol?: string | null;
  side: 'BUY' | 'SELL';
  price?: number | null;
  size?: number | null;
  txSig?: string | null;
  route?: string | null;
  feeLamports?: number | null;
  pnlPercent?: number | null;
  status?: string;
  createdAt?: number;
}

export interface TradeRecord {
  id: string;
  positionId: string | null;
  symbol: string | null;
  side: 'BUY' | 'SELL';
  price: number | null;
  size: number | null;
  txSig: string | null;
  route: string | null;
  feeLamports: number | null;
  pnlPercent: number | null;
  status: string;
  createdAt: number;
}

export const insertTrade = (input: TradeInsert): string => {
  const db = ensureDatabase();
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? Date.now();

  const stmt = db.prepare(
    `INSERT INTO trades (
      id,
      position_id,
      symbol,
      side,
      price,
      size,
      tx_sig,
      route,
      fee_lamports,
      pnl_percent,
      status,
      created_at
    ) VALUES (@id, @positionId, @symbol, @side, @price, @size, @txSig, @route, @feeLamports, @pnlPercent, @status, @createdAt)`
  );

  stmt.run({
    id,
    positionId: input.positionId ?? null,
    symbol: input.symbol ?? null,
    side: input.side,
    price: input.price ?? null,
    size: input.size ?? null,
    txSig: input.txSig ?? null,
    route: input.route ?? null,
    feeLamports: input.feeLamports ?? null,
    pnlPercent: input.pnlPercent ?? null,
    status: input.status ?? 'pending',
    createdAt
  });

  return id;
};

export const listTrades = (limit = 100): TradeRecord[] => {
  const db = ensureDatabase();
  const rows = db
    .prepare(
      `SELECT id, position_id AS positionId, symbol, side, price, size, tx_sig AS txSig, route, fee_lamports AS feeLamports, pnl_percent AS pnlPercent, status, created_at AS createdAt
       FROM trades
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as TradeRecord[];
  return rows;
};

export interface HealthStatusUpsert {
  id: string;
  component: string;
  status: string;
  details?: string | null;
  isHealthy?: boolean;
  timestamp?: number;
}

export interface HealthRecord {
  id: string;
  component: string;
  status: string;
  lastOk: number | null;
  details: string | null;
  createdAt: number;
}

export const upsertHealthStatus = (input: HealthStatusUpsert): void => {
  const db = ensureDatabase();
  const createdAt = input.timestamp ?? Date.now();
  const lastOk = input.isHealthy ?? input.status.toLowerCase() === 'ok' ? createdAt : null;

  const stmt = db.prepare(
    `INSERT INTO health (id, component, status, last_ok, details, created_at)
     VALUES (@id, @component, @status, @lastOk, @details, @createdAt)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       last_ok = excluded.last_ok,
       details = excluded.details,
       created_at = excluded.created_at`
  );

  stmt.run({
    id: input.id,
    component: input.component,
    status: input.status,
    lastOk,
    details: input.details ?? null,
    createdAt
  });
};

export const listHealthRecords = (): HealthRecord[] => {
  const db = ensureDatabase();
  const rows = db
    .prepare(
      `SELECT id, component, status, last_ok AS lastOk, details, created_at AS createdAt
       FROM health`
    )
    .all() as HealthRecord[];
  return rows;
};
