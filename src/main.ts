import { loadConfig } from "./config";
import { getDB } from "./db";
import { startMetricsServer } from "./telemetry/metrics";
import { maybeStartTelegram } from "./ops/telegram";

async function main() {
  const cfg = loadConfig();
  getDB(); // ensure DB ready
  startMetricsServer();
  maybeStartTelegram();

  const mode = cfg.DRY_RUN ? "DRY-RUN" : "LIVE";
  console.log(`[SnipeBT] Started in ${mode}. Health => /health, Metrics => /metrics on port ${cfg.METRICS_PORT}`);
  // TODO: initialize streams, risk checks, Jupiter swap builder, RPC failover, strategy loop
}

main().catch((e)=>{ console.error(e); process.exit(1); });
