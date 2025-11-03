import { z } from "zod";

export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development","staging","production"]).default("development"),
  DRY_RUN: z.coerce.boolean().default(true),
  RPC_PRIMARY: z.string().url(),
  RPC_BACKUP: z.string().url().optional(),
  JUPITER_BASE_URL: z.string().url().default("https://quote-api.jup.ag/v6"),
  SLIPPAGE_BPS: z.coerce.number().int().min(0).max(5000).default(100),
  MAX_RISK_PCT: z.coerce.number().min(0).max(1).default(0.02),
  MAX_POS_PCT: z.coerce.number().min(0).max(1).default(0.05),
  MAX_CU_PRICE: z.coerce.number().int().min(0).default(1000),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  METRICS_PORT: z.coerce.number().int().default(8080),
  DATA_DIR: z.string().default("./data"),
  WALLET_PRIVATE_KEY_ID: z.string().optional(), // reference for secrets provider
});

export type AppEnv = {
  NODE_ENV: "development" | "staging" | "production";
  DRY_RUN: boolean;
  RPC_PRIMARY: string;
  RPC_BACKUP?: string;
  JUPITER_BASE_URL: string;
  SLIPPAGE_BPS: number;
  MAX_RISK_PCT: number;
  MAX_POS_PCT: number;
  MAX_CU_PRICE: number;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  METRICS_PORT: number;
  DATA_DIR: string;
  WALLET_PRIVATE_KEY_ID?: string;
};
