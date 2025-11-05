import { loadConfig } from "./config";
import { getDB } from "./db";
import { startMetricsServer } from "./telemetry/metrics";
import { maybeStartTelegram } from "./ops/telegram";
import { AiGenerateRequest, AiOrchestrator, createAiOrchestrator } from "./ai";

function summarize(text: string, limit = 360): string {
  if (!text) return "";
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 3)}...` : cleaned;
}

function buildStartupRequest(cfg: ReturnType<typeof loadConfig>): AiGenerateRequest {
  return {
    messages: [
      {
        role: "system",
        content:
          "You are the AI ensemble supporting the SnipeBT Solana trading bot. Respond with a concise readiness summary.",
      },
      {
        role: "user",
        content:
          "Assess system readiness based on the provided runtime context and list the top two priorities to begin trading.",
      },
    ],
    context: {
      mode: cfg.DRY_RUN ? "dry-run" : "live",
      rpcPrimary: cfg.RPC_PRIMARY,
      metricsPort: cfg.METRICS_PORT,
      telegramConfigured: Boolean(cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID),
    },
    temperature: 0.2,
    maxOutputTokens: 400,
  };
}

async function warmupAi(orchestrator: AiOrchestrator, cfg: ReturnType<typeof loadConfig>) {
  const registered = orchestrator.listProviders();
  console.log(`[AI] Registered providers: ${registered.length ? registered.join(", ") : "none"}`);

  const healthReports = await orchestrator.health();
  const hasReadyProvider = healthReports.some((report) => report.ok);
  healthReports.forEach((report) => {
    const status = report.ok ? "READY" : "UNAVAILABLE";
    const details = report.message ? ` - ${report.message}` : "";
    console.log(`[AI][${report.provider}] ${status}${details}`);
  });

  if (!hasReadyProvider) {
    console.warn("[AI] No AI backends passed health checks. Configure Ollama or Council credentials to enable AI workflows.");
    return;
  }

  try {
    const startupRequest = buildStartupRequest(cfg);
    const result = await orchestrator.generate(startupRequest);
    if (result.primary) {
      console.log(
        `[AI][${result.primary.provider}] Warm-up response: ${summarize(result.primary.output)}`
      );
    }
    if (result.errors.length > 0) {
      const errors = result.errors.map((err) => `${err.provider}: ${err.message}`).join("; ");
      console.warn(`[AI] Issues reported by providers: ${errors}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[AI] Warm-up orchestration failed: ${message}`);
  }
}

async function main() {
  const cfg = loadConfig();
  getDB(); // ensure persistence ready (SQLite or JSON fallback)
  startMetricsServer();
  maybeStartTelegram();

  const aiOrchestrator = createAiOrchestrator();
  await warmupAi(aiOrchestrator, cfg);

  const mode = cfg.DRY_RUN ? "DRY-RUN" : "LIVE";
  console.log(`[SnipeBT] Started in ${mode}. Health => /health, Metrics => /metrics on ${cfg.METRICS_PORT}`);
  // TODO: strategy stream, risk evaluation, Jupiter swap building, RPC failover
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
