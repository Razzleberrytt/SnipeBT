import "dotenv/config";
import { EnvSchema, type AppEnv } from "./env.schema";

let cached: AppEnv | null = null;

export function loadConfig(): AppEnv {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.format());
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}
