import http from "http";
import client from "prom-client";
import { loadConfig } from "../config";

export const tradesSubmitted = new client.Counter({ name: "trades_submitted_total", help: "Trades submitted" });
export const tradesConfirmed = new client.Counter({ name: "trades_confirmed_total", help: "Trades confirmed" });

export function startMetricsServer() {
  const cfg = loadConfig();
  client.collectDefaultMetrics();
  const server = http.createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": client.register.contentType });
      res.end(await client.register.metrics());
    } else if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  server.listen(cfg.METRICS_PORT);
  return server;
}
