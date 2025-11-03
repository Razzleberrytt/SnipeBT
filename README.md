# SnipeBT

Hardened Solana sniping bot designed for secure dry-run trading by default. This README covers
setup, configuration, operational controls, and observability for day-to-day operations.

## Prerequisites

- Node.js 20.x (LTS)
- npm 10.x (bundled with Node 20)
- Access to two Solana RPC endpoints (primary and backup)
- Optional: HashiCorp Vault or 1Password for secret storage (local keytar-based storage is the default)

## Installation

```bash
npm ci --legacy-peer-deps
npm run build
```

The project uses SQLite for persistence. The database file is stored in `./data/snipebt.sqlite`
by default and is created automatically.

## Environment configuration

Copy `.env.example` to the desired environment file (`.env.dev`, `.env.staging`, or `.env.prod`) and
fill in the required values. Environment variables are validated at startup via Zod and the process
will terminate if configuration is invalid.

| Variable | Required | Description |
| --- | --- | --- |
| `RPC_PRIMARY` | ✅ | Primary Solana RPC endpoint URL |
| `RPC_BACKUP` | ✅ | Comma-separated list of backup RPC endpoints |
| `JUPITER_BASE_URL` | ✅ | Jupiter API base URL |
| `SLIPPAGE_BPS` | ✅ | Maximum allowed slippage per trade (basis points) |
| `MAX_RISK_PCT` | ✅ | Global exposure limit as % of equity |
| `MAX_POS_PCT` | ✅ | Per-position exposure limit as % of equity |
| `MAX_CU_PRICE` | ✅ | Maximum compute unit price (micro lamports) |
| `TELEGRAM_BOT_TOKEN` | Optional | Telegram bot token for ops console |
| `TELEGRAM_CHAT_ID` | Optional | Allowed Telegram chat ID (must accompany bot token) |
| `METRICS_PORT` | Optional (default `9464`) | Port that exposes Prometheus metrics |
| `DATA_DIR` | Optional (default `./data`) | Directory for SQLite and artifacts |
| `DRY_RUN` | Optional (default `true`) | Default dry-run behavior unless overridden |
| `SECRET_PROVIDER` | Optional | `local`, `vault`, or `1password` |
| `SECRET_SERVICE` | Conditional | Required when using Vault or 1Password |
| `SECRET_ACCOUNT` | Conditional | Account identifier for the configured secret backend |

### Secrets management

Secrets default to the local keychain via [`keytar`](https://github.com/atom/node-keytar). Provide
`SECRET_PROVIDER=vault` or `SECRET_PROVIDER=1password` alongside the required service/account values
to route lookups elsewhere. Avoid storing raw private keys in `.env`; store references instead and
hydrate them through the configured secrets provider.

## Runtime modes & CLI

Runtime mode is selected via CLI flags when invoking `dist/main.js` (used by npm scripts and Docker):

- `--mode dry` (default) – dry-run execution. Trades are simulated and recorded without submission.
- `--mode paper` or `--paper-only` – paper trading. Matches dry-run but flagged separately for metrics.
- `--mode staging` or `--staging` – staging environment with live routing but dry submissions.
- `--mode live --live` – live trading. The `--live` acknowledgement flag is mandatory; without it the
  runtime refuses to send transactions.
- `--dry-run` – forces dry-run even if `--mode live` is supplied.

### npm scripts

| Command | Description |
| --- | --- |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:dev` | Hot-reload development mode (dry-run) |
| `npm run start:dry` | Execute compiled app in dry-run mode |
| `npm run start:live` | Execute compiled app in live mode (still requires production `.env` and `--live`) |
| `npm run migrate` | Import legacy JSON history into SQLite |
| `npm run lint` | Run ESLint on source files |
| `npm run test` | Run Jest unit tests |
| `npm run health` | Execute health checks once |

## Risk guardrail overview

Risk checks are centrally enforced via `src/risk/index.ts`:

- **Global exposure:** total notional exposure capped by `MAX_RISK_PCT` of current equity.
- **Per-position exposure:** individual mint exposure capped by `MAX_POS_PCT`.
- **Slippage guard:** rejects quotes requiring slippage above `SLIPPAGE_BPS`.
- **Compute budget cap:** ensures `MAX_CU_PRICE` is not exceeded.
- **Deny lists:** in-memory deny lists for mints and creators (`addDeniedMint`, `addDeniedCreator`).
- **Token safety checks:** fetches mint account metadata and warns when authorities are not renounced.

All trade intents must pass these guards before the transaction is built and forwarded to the
submitter.

## Persistence

Runtime data lives in SQLite with the following tables:

- `positions` – tracked open positions and entry prices.
- `trades` – all trade attempts (successful, failed, or dry-run) with routing metadata.
- `configs` – persisted configuration overrides.
- `health` – latest health-check results.

The migration script (`npm run migrate`) imports `entryPrices.json` and `tradeHistory.json` into the
SQLite store and moves the original files to `*.bak` for safekeeping.

## Observability

- **Logging:** `pino` provides structured logs. Development mode uses `pino-pretty` for readability.
- **Metrics:** `prom-client` exposes `/metrics` on the configured port (default `9464`). Key metrics:
  - Counters: `trades_submitted_total`, `trades_confirmed_total`, `trades_failed_total`
  - Gauges: `equity_estimate_usd`, `open_positions`, `rpc_error_rate`
  - Histogram: `tx_latency_ms`
- **Health checks:** RPC endpoints, Jupiter API, and SQLite connectivity are evaluated every minute
  and persisted to the `health` table. Invoke `npm run health` for an on-demand snapshot.

## Telegram operations console

When `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are provided, the bot starts an operations console
with the following commands:

- `/status` – current live/dry mode, estimated equity, and open position count.
- `/pause` / `/resume` – toggles live trading. Resume is ignored unless the runtime was started in
  live mode with the `--live` flag.
- `/liquidate_all` – placeholder for future liquidation logic (currently logs a warning).
- `/health` – displays current health-check results and the persisted history.

Alerts are emitted when the circuit breaker trips or error rates are elevated.

## Operations runbook

### Starting the bot

1. Ensure `.env.dev` (or appropriate env file) is up to date.
2. Run database migration if upgrading from the JSON store:
   ```bash
   npm run migrate
   ```
3. Start in dry mode for validation:
   ```bash
   npm run start:dry
   ```
4. Verify metrics at `http://localhost:9464/metrics` and health checks via the `/health` command
   (if Telegram is configured) or by running `npm run health`.
5. When ready for production, launch with:
   ```bash
   npm run start:live -- --live
   ```
   Ensure RPC endpoints, wallet funding, and risk settings are double-checked beforehand.

### Pausing & resuming trading

- Use `/pause` and `/resume` in Telegram.
- From the CLI, send `SIGINT`/`SIGTERM` to exit. The runtime shuts down cleanly and can be restarted
  in dry mode for diagnostics.

### Handling degraded health or RPC failover

- Inspect `/metrics` for `rpc_error_rate` spikes.
- Check the `health` table (or `/health` command) for failing components.
- Confirm backup RPC URLs in `.env`. The submitter automatically rotates to backups after repeated
  failures and opens the circuit breaker to prevent live submissions when reliability is poor.

### Database maintenance

- Backup `./data/snipebt.sqlite` regularly (hot backup is safe with WAL mode).
- To migrate or repair, stop the bot, copy the database file, run SQL migrations as needed, then
  restart. Use `sqlite3` or `scripts/migrate-json-to-sqlite.ts` for imports.

### Secret rotation

- Update the secret in the configured provider (local keytar, Vault, or 1Password).
- Restart the bot to pick up the new value. If using the local provider, run `npm run start:dry`
  once to confirm secrets resolve and no transactions are attempted.

## Docker usage

Build the image locally:

```bash
docker build -t snipebt:latest .
```

Launch via Compose (choose an appropriate profile):

```bash
docker compose --profile dev up --build
```

Profiles available:

- `dev` – dry-run mode with `.env.dev`.
- `staging` – staging mode with `.env.staging` and dry submissions.
- `live` – live trading with `.env.prod`. Requires `--live` acknowledgement baked into the command.

Each service mounts `./data` as `/app/data` and exposes metrics on `9464`.

## Continuous Integration

GitHub Actions (`.github/workflows/ci.yml`) enforce:

- Dependency installation via `npm ci`
- ESLint on TypeScript/JavaScript files
- Jest unit tests
- Type checking (`npm run build`)
- `gitleaks` secret scanning
- Docker image build validation

## Acceptance checklist

- `npm run migrate` – creates the SQLite database and imports legacy JSON (when present).
- `npm run start:dry` – boots the runtime, starts metrics server, and keeps trading in dry-run mode.
- Simulate RPC errors to observe automatic failover and circuit breaker alerts (see logs/Telegram).
- With Telegram configured, `/status` reflects current mode and `/pause` halts live submissions while
  dry-run continues.
- Invoking `node dist/main.js --mode live --live ...` executes real transactions and records the
  resulting signatures in SQLite when risk checks pass.
