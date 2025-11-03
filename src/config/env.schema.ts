import { z } from "../vendor/zod";
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development","staging","production"]).default("development"),
  DRY_RUN: z.coerce.boolean().default(true),
  RPC_PRIMARY: z.string().default("http://localhost:8899"),
  RPC_BACKUP: z.string().optional(),
  JUPITER_BASE_URL: z.string().default("https://quote-api.jup.ag/v6"),
  SLIPPAGE_BPS: z.coerce.number().default(100),
  MAX_RISK_PCT: z.coerce.number().default(0.02),
  MAX_POS_PCT: z.coerce.number().default(0.05),
  MAX_CU_PRICE: z.coerce.number().default(1000),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  METRICS_PORT: z.coerce.number().default(8080),
  DATA_DIR: z.string().default("./data"),
  WALLET_PRIVATE_KEY_ID: z.string().optional()
});
export type AppEnv = any; // retains shape even with zod-lite; real zod will infer
