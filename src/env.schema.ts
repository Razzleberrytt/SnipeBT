import { z } from 'zod';

const optionalString = () =>
  z
    .string()
    .transform((value: string) => value.trim())
    .transform((value: string) => (value.length === 0 ? undefined : value))
    .optional()
    .default(undefined);

export const envSchema = z
  .object({
    RPC_PRIMARY: z.string().url({ message: 'RPC_PRIMARY must be a valid URL' }),
    RPC_BACKUP: z.string().url({ message: 'RPC_BACKUP must be a valid URL' }),
    JUPITER_BASE_URL: z.string().url({ message: 'JUPITER_BASE_URL must be a valid URL' }),
    SLIPPAGE_BPS: z.coerce
      .number({ invalid_type_error: 'SLIPPAGE_BPS must be a number' })
      .int()
      .nonnegative(),
    MAX_RISK_PCT: z.coerce
      .number({ invalid_type_error: 'MAX_RISK_PCT must be a number' })
      .min(0)
      .max(100),
    MAX_POS_PCT: z.coerce
      .number({ invalid_type_error: 'MAX_POS_PCT must be a number' })
      .min(0)
      .max(100),
    MAX_CU_PRICE: z.coerce
      .number({ invalid_type_error: 'MAX_CU_PRICE must be a number' })
      .int()
      .nonnegative(),
    TELEGRAM_BOT_TOKEN: optionalString(),
    TELEGRAM_CHAT_ID: optionalString(),
    METRICS_PORT: z.coerce
      .number({ invalid_type_error: 'METRICS_PORT must be a number' })
      .int()
      .min(1024)
      .max(65535)
      .default(9464),
    DATA_DIR: z.string().min(1).default('./data'),
    DRY_RUN: z.coerce.boolean().default(true),
    SECRET_PROVIDER: z
      .enum(['local', 'vault', '1password'])
      .default('local'),
    SECRET_SERVICE: optionalString(),
    SECRET_ACCOUNT: optionalString()
  })
  .superRefine((value, ctx: z.RefinementCtx) => {
    const botTokenProvided = Boolean(value.TELEGRAM_BOT_TOKEN);
    const chatIdProvided = Boolean(value.TELEGRAM_CHAT_ID);
    if (botTokenProvided !== chatIdProvided) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be provided together',
        path: ['TELEGRAM_BOT_TOKEN']
      });
    }

    if (value.SECRET_PROVIDER !== 'local' && !value.SECRET_SERVICE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SECRET_SERVICE is required when using external secret providers',
        path: ['SECRET_SERVICE']
      });
    }
  });

export type EnvSchema = z.infer<typeof envSchema>;

export function parseEnv(env: NodeJS.ProcessEnv): EnvSchema {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const error = result.error.flatten((issue: z.ZodIssue) => issue.message);
    const message = Object.values(error.fieldErrors)
      .flat()
      .filter(Boolean)
      .join(', ');
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  return result.data;
}
