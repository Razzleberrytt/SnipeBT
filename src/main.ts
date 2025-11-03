import { loadConfig } from "./config";
import { startMetricsServer } from "./telemetry/metrics";

async function main() {
  const cfg = loadConfig();
  startMetricsServer();
  if (cfg.DRY_RUN) {
    console.log("Running in DRY-RUN mode. Use --live to enable real transactions.");
  }
  // TODO: initialize streams, risk checks, router calls, execution loop
}
main().catch((e)=>{ console.error(e); process.exit(1); });
