import http from 'node:http';

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import { getConfig } from '../config';
import logger from '../lib/logger';

const register = new Registry();
collectDefaultMetrics({ register });

const tradesSubmitted = new Counter({
  name: 'trades_submitted_total',
  help: 'Total number of trades submitted to the network.',
  registers: [register]
});

const tradesConfirmed = new Counter({
  name: 'trades_confirmed_total',
  help: 'Total number of trades confirmed on-chain.',
  registers: [register]
});

const tradesFailed = new Counter({
  name: 'trades_failed_total',
  help: 'Total number of trades that failed to confirm.',
  registers: [register]
});

const equityEstimate = new Gauge({
  name: 'equity_estimate_usd',
  help: 'Estimated total portfolio equity in USD.',
  registers: [register]
});

const openPositionsGauge = new Gauge({
  name: 'open_positions',
  help: 'Number of open positions currently tracked.',
  registers: [register]
});

const rpcErrorRateGauge = new Gauge({
  name: 'rpc_error_rate',
  help: 'Rolling RPC error rate represented as a ratio (0-1).',
  registers: [register]
});

const txLatencyHistogram = new Histogram({
  name: 'tx_latency_ms',
  help: 'Observed transaction submission latency in milliseconds.',
  registers: [register],
  buckets: [50, 100, 250, 500, 1000, 2000, 5000]
});

export const recordTradeSubmission = () => tradesSubmitted.inc();
export const recordTradeConfirmation = (latencyMs: number) => {
  tradesConfirmed.inc();
  txLatencyHistogram.observe(latencyMs);
};
export const recordTradeFailure = () => tradesFailed.inc();

export const setEquityEstimate = (value: number) => equityEstimate.set(value);
export const setOpenPositions = (value: number) => openPositionsGauge.set(value);
export const setRpcErrorRate = (value: number) => rpcErrorRateGauge.set(value);

export const startMetricsServer = (port?: number) => {
  const targetPort = port ?? getConfig().metrics.port;
  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end();
      return;
    }

    if (req.url === '/metrics') {
      try {
        const metrics = await register.metrics();
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(metrics);
      } catch (error) {
        logger.error({ err: error }, 'Failed to collect metrics');
        res.writeHead(500);
        res.end('metrics collection failed');
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(targetPort, () => {
    logger.info({ port: targetPort }, 'Metrics server listening');
  });

  return server;
};
