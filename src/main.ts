import { loadConfig } from "./config";
import { getDB } from "./db";
import { startMetricsServer } from "./telemetry/metrics";
import { maybeStartTelegram } from "./ops/telegram";
async function main(){
  const cfg = loadConfig();
  getDB(); // ensure persistence ready (SQLite or JSON fallback)
  startMetricsServer();
  maybeStartTelegram();
  const mode = cfg.DRY_RUN ? "DRY-RUN" : "LIVE";
  console.log(`[SnipeBT] Started in ${mode}. Health => /health, Metrics => /metrics on ${cfg.METRICS_PORT}`);
  // TODO: strategy stream, risk evaluation, Jupiter swap building, RPC failover
}
main().catch(e=>{ console.error(e); process.exit(1); });
