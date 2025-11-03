import fs from 'node:fs';
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';

import { parseEnv } from '../env.schema';

export interface RpcConfig {
  primary: string;
  backups: string[];
}

export interface JupiterConfig {
  baseUrl: string;
}

export interface RiskConfig {
  slippageBps: number;
  maxRiskPct: number;
  maxPositionPct: number;
  maxComputeUnitPrice: number;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
}

export type SecretProviderType = 'local' | 'vault' | '1password';

export interface SecretsConfig {
  provider: SecretProviderType;
  service?: string;
  account?: string;
}

export interface AppConfig {
  rpc: RpcConfig;
  jupiter: JupiterConfig;
  risk: RiskConfig;
  telegram: TelegramConfig;
  secrets: SecretsConfig;
  dataDir: string;
  dryRun: boolean;
  metrics: {
    port: number;
  };
}

let cachedConfig: AppConfig | null = null;

const normalizeBackups = (value: string): string[] =>
  value
    .split(',')
    .map((endpoint) => endpoint.trim())
    .filter((endpoint) => endpoint.length > 0);

const ensureDataDir = (target: string) => {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
};

export function loadConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  loadDotenv();

  const rawEnv = parseEnv(process.env);

  const backups = normalizeBackups(rawEnv.RPC_BACKUP);

  if (backups.length === 0) {
    throw new Error('At least one RPC backup endpoint must be provided via RPC_BACKUP');
  }

  const dataDir = path.resolve(process.cwd(), rawEnv.DATA_DIR);
  ensureDataDir(dataDir);

  const config: AppConfig = Object.freeze({
    rpc: {
      primary: rawEnv.RPC_PRIMARY,
      backups
    },
    jupiter: {
      baseUrl: rawEnv.JUPITER_BASE_URL
    },
    risk: {
      slippageBps: rawEnv.SLIPPAGE_BPS,
      maxRiskPct: rawEnv.MAX_RISK_PCT,
      maxPositionPct: rawEnv.MAX_POS_PCT,
      maxComputeUnitPrice: rawEnv.MAX_CU_PRICE
    },
    telegram: {
      enabled: Boolean(rawEnv.TELEGRAM_BOT_TOKEN && rawEnv.TELEGRAM_CHAT_ID),
      botToken: rawEnv.TELEGRAM_BOT_TOKEN ?? undefined,
      chatId: rawEnv.TELEGRAM_CHAT_ID ?? undefined
    },
    secrets: {
      provider: rawEnv.SECRET_PROVIDER,
      service: rawEnv.SECRET_SERVICE ?? undefined,
      account: rawEnv.SECRET_ACCOUNT ?? undefined
    },
    metrics: {
      port: rawEnv.METRICS_PORT
    },
    dataDir,
    dryRun: rawEnv.DRY_RUN
  });

  cachedConfig = config;
  return config;
}

export function getConfig(): AppConfig {
  return cachedConfig ?? loadConfig();
}

export function resetConfig(): void {
  cachedConfig = null;
}
