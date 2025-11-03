CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  entry_price REAL,
  size REAL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions (mint);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  position_id TEXT,
  symbol TEXT,
  side TEXT NOT NULL,
  price REAL,
  size REAL,
  tx_sig TEXT,
  route TEXT,
  fee_lamports INTEGER,
  pnl_percent REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (position_id) REFERENCES positions(id)
);
CREATE INDEX IF NOT EXISTS idx_trades_position ON trades (position_id);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades (created_at);

CREATE TABLE IF NOT EXISTS configs (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_configs_key ON configs (key);

CREATE TABLE IF NOT EXISTS health (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  status TEXT NOT NULL,
  last_ok INTEGER,
  details TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_health_component ON health (component);
