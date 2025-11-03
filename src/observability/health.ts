import axios from 'axios';
import { Connection } from '@solana/web3.js';

import { getConfig } from '../config';
import { upsertHealthStatus, withDb } from '../db';
import logger from '../lib/logger';

export interface ComponentHealth {
  component: string;
  status: 'ok' | 'warn' | 'error';
  details?: string;
  checkedAt: number;
}

const now = () => Date.now();

export const checkRpcHealth = async (endpoint: string, label: string): Promise<ComponentHealth> => {
  const connection = new Connection(endpoint, { commitment: 'processed' });
  try {
    const slot = await connection.getSlot();
    const details = `slot=${slot}`;
    upsertHealthStatus({
      id: `rpc:${label}`,
      component: label,
      status: 'ok',
      details,
      isHealthy: true,
      timestamp: now()
    });
    return { component: label, status: 'ok', details, checkedAt: now() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    upsertHealthStatus({
      id: `rpc:${label}`,
      component: label,
      status: 'error',
      details: message,
      isHealthy: false,
      timestamp: now()
    });
    return { component: label, status: 'error', details: message, checkedAt: now() };
  }
};

export const checkRouterHealth = async (): Promise<ComponentHealth> => {
  const { jupiter } = getConfig();
  try {
    await axios.get(jupiter.baseUrl, { timeout: 3000 });
    upsertHealthStatus({
      id: 'router:jupiter',
      component: 'router',
      status: 'ok',
      details: 'reachable',
      isHealthy: true,
      timestamp: now()
    });
    return { component: 'router', status: 'ok', details: 'reachable', checkedAt: now() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    upsertHealthStatus({
      id: 'router:jupiter',
      component: 'router',
      status: 'error',
      details: message,
      isHealthy: false,
      timestamp: now()
    });
    return { component: 'router', status: 'error', details: message, checkedAt: now() };
  }
};

export const checkDatabaseHealth = async (): Promise<ComponentHealth> => {
  try {
    await withDb((db) => db.prepare('SELECT 1').get());
    upsertHealthStatus({
      id: 'database',
      component: 'database',
      status: 'ok',
      details: 'reachable',
      isHealthy: true,
      timestamp: now()
    });
    return { component: 'database', status: 'ok', details: 'reachable', checkedAt: now() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    upsertHealthStatus({
      id: 'database',
      component: 'database',
      status: 'error',
      details: message,
      isHealthy: false,
      timestamp: now()
    });
    return { component: 'database', status: 'error', details: message, checkedAt: now() };
  }
};

export const runHealthChecks = async (): Promise<ComponentHealth[]> => {
  const config = getConfig();
  const checks: Promise<ComponentHealth>[] = [
    checkRpcHealth(config.rpc.primary, 'rpc_primary'),
    ...config.rpc.backups.map((endpoint, idx) => checkRpcHealth(endpoint, `rpc_backup_${idx + 1}`)),
    checkRouterHealth(),
    checkDatabaseHealth()
  ];

  const results = await Promise.all(checks);
  results.forEach((result) => {
    if (result.status !== 'ok') {
      logger.warn({ component: result.component, details: result.details }, 'Health check reported a non-OK status');
    }
  });
  return results;
};
