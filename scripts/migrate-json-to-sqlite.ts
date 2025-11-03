#!/usr/bin/env ts-node

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../src/config';
import { getDb, insertTrade, upsertPosition } from '../src/db';

interface LegacyTradeEntry {
  type: 'BUY' | 'SELL';
  symbol: string;
  timestamp: string;
  pnlPercent?: number;
}

const tradeHistoryPath = path.resolve(process.cwd(), 'tradeHistory.json');
const entryPricesPath = path.resolve(process.cwd(), 'entryPrices.json');

const backupFile = (filePath: string) => {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.renameSync(filePath, backupPath);
  }
};

const migrateEntryPrices = () => {
  if (!fs.existsSync(entryPricesPath)) {
    console.log('No legacy entryPrices.json detected, skipping.');
    return;
  }

  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(1) as count FROM positions').get() as { count: number };
  if (count > 0) {
    console.log('Positions table already populated; skipping entry price migration.');
    backupFile(entryPricesPath);
    return;
  }

  const raw = JSON.parse(fs.readFileSync(entryPricesPath, 'utf8')) as Record<string, number>;
  const entries = Object.entries(raw);

  console.log(`Migrating ${entries.length} entry price records to SQLite...`);
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const [mint, price] of entries) {
      const numeric = Number(price);
      if (!Number.isFinite(numeric)) {
        console.warn(`Skipping entry price for ${mint}: invalid number`);
        continue;
      }
      upsertPosition({
        id: mint,
        mint,
        entryPrice: numeric,
        status: 'open',
        createdAt: now
      });
    }
  });
  tx();

  backupFile(entryPricesPath);
  console.log('Entry prices migrated successfully.');
};

const migrateTradeHistory = () => {
  if (!fs.existsSync(tradeHistoryPath)) {
    console.log('No legacy tradeHistory.json detected, skipping.');
    return;
  }

  const db = getDb();
  const { count } = db.prepare('SELECT COUNT(1) as count FROM trades').get() as { count: number };
  if (count > 0) {
    console.log('Trades table already populated; skipping trade history migration.');
    backupFile(tradeHistoryPath);
    return;
  }

  const raw = JSON.parse(fs.readFileSync(tradeHistoryPath, 'utf8')) as LegacyTradeEntry[];
  if (!Array.isArray(raw)) {
    console.warn('tradeHistory.json is not an array; skipping migration.');
    return;
  }

  console.log(`Migrating ${raw.length} trade history records to SQLite...`);
  const tx = db.transaction(() => {
    for (const entry of raw) {
      const createdAt = Number.isFinite(Date.parse(entry.timestamp))
        ? new Date(entry.timestamp).getTime()
        : Date.now();
      insertTrade({
        symbol: entry.symbol,
        positionId: entry.symbol,
        side: entry.type === 'SELL' ? 'SELL' : 'BUY',
        createdAt,
        pnlPercent: entry.pnlPercent ?? null
      });
    }
  });
  tx();

  backupFile(tradeHistoryPath);
  console.log('Trade history migrated successfully.');
};

const main = async () => {
  loadConfig();
  migrateEntryPrices();
  migrateTradeHistory();
};

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
