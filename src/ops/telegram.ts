import type { Context } from 'telegraf';
import { Telegraf } from 'telegraf';

import { getConfig } from '../config';
import { listHealthRecords } from '../db';
import { TransactionSubmitter } from '../exec/submitter';
import logger from '../lib/logger';
import { runHealthChecks } from '../observability/health';

export interface TelegramOpsContext {
  submitter: TransactionSubmitter;
  getEquityEstimate: () => Promise<number> | number;
  getOpenPositions: () => Promise<number> | number;
  pauseTrading: () => void;
  resumeTrading: () => void;
  liquidateAll: () => Promise<void>;
}

const ensurePromise = async <T>(value: Promise<T> | T): Promise<T> => value;

export class TelegramOpsConsole {
  private readonly bot: Telegraf;
  private readonly allowedChats: Set<string>;
  private readonly chatId: string;
  private isRunning = false;

  constructor(private readonly context: TelegramOpsContext) {
    const config = getConfig();
    if (!config.telegram.enabled || !config.telegram.botToken || !config.telegram.chatId) {
      throw new Error('Telegram configuration missing. Cannot initialize ops console.');
    }

    this.chatId = config.telegram.chatId;
    this.allowedChats = new Set([this.chatId]);
    this.bot = new Telegraf(config.telegram.botToken);
    this.registerMiddleware();
    this.registerHandlers();
    this.attachSubmitterHooks(context.submitter);
  }

  private registerMiddleware() {
    this.bot.use(async (ctx: Context, next) => {
      const chatId = ctx.chat?.id ? String(ctx.chat.id) : undefined;
      if (!chatId || !this.allowedChats.has(chatId)) {
        logger.warn({ chatId }, 'Unauthorized Telegram access attempt');
        return;
      }
      return next();
    });
  }

  private registerHandlers() {
    this.bot.command('status', async (ctx) => {
      try {
        const [equity, positions] = await Promise.all([
          ensurePromise(this.context.getEquityEstimate()),
          ensurePromise(this.context.getOpenPositions())
        ]);
        const status = [
          `Live trading: ${this.context.submitter.isCircuitOpen() ? 'paused (circuit open)' : 'active'}`,
          `Equity (est): ${Number.isFinite(equity) ? equity.toFixed(2) : 'n/a'}`,
          `Open positions: ${Number.isFinite(positions) ? positions : 'n/a'}`
        ].join('\n');
        await ctx.reply(status);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error }, 'Failed to gather status');
        await ctx.reply(`Failed to gather status: ${message}`);
      }
    });

    this.bot.command('pause', async (ctx) => {
      this.context.pauseTrading();
      await ctx.reply('Live trading paused.');
    });

    this.bot.command('resume', async (ctx) => {
      this.context.resumeTrading();
      await ctx.reply('Live trading resumed.');
    });

    this.bot.command('liquidate_all', async (ctx) => {
      await ctx.reply('Initiating liquidation of all positions...');
      try {
        await this.context.liquidateAll();
        await ctx.reply('Liquidation request submitted.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error }, 'Liquidation command failed');
        await ctx.reply(`Liquidation failed: ${message}`);
      }
    });

    this.bot.command('health', async (ctx) => {
      try {
        const health = await runHealthChecks();
        const persisted = listHealthRecords();
        const summary = health
          .map((entry) => `${entry.component}: ${entry.status}${entry.details ? ` (${entry.details})` : ''}`)
          .join('\n');
        const persistedSummary = persisted
          .map((entry) => `${entry.component}: ${entry.status}${entry.details ? ` (${entry.details})` : ''}`)
          .join('\n');
        await ctx.reply(`Active health checks:\n${summary}\n\nLast recorded statuses:\n${persistedSummary}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error }, 'Health check command failed');
        await ctx.reply(`Health check failed: ${message}`);
      }
    });
  }

  private attachSubmitterHooks(submitter: TransactionSubmitter) {
    submitter.on('circuit_open', (payload) => {
      this.sendAlert(`⚠️ Circuit breaker engaged after ${payload.failures} consecutive failures on ${payload.endpoint}.`);
    });

    submitter.on('high_failure_rate', (payload) => {
      this.sendAlert(
        `⚠️ Elevated failure rate detected: ${(payload.errorRate * 100).toFixed(1)}% over ${payload.attempts} attempts.`
      );
    });
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    await this.bot.launch();
    this.isRunning = true;
    logger.info('Telegram ops console started');
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    await this.bot.stop('manual');
    this.isRunning = false;
  }

  public async notifyWalletBalanceLow(balance: number): Promise<void> {
    await this.sendAlert(`⚠️ Wallet balance is low: ${balance.toFixed(4)} SOL remaining.`);
  }

  private async sendAlert(message: string): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    try {
      await this.bot.telegram.sendMessage(this.chatId, message);
    } catch (error) {
      logger.error({ err: error }, 'Failed to send Telegram alert');
    }
  }
}

export const initializeTelegramOps = (context: TelegramOpsContext): TelegramOpsConsole | null => {
  const config = getConfig();
  if (!config.telegram.enabled || !config.telegram.botToken || !config.telegram.chatId) {
    logger.info('Telegram ops console disabled. Missing configuration.');
    return null;
  }

  try {
    const consoleInstance = new TelegramOpsConsole(context);
    void consoleInstance.start();
    return consoleInstance;
  } catch (error) {
    logger.error({ err: error }, 'Unable to start Telegram ops console');
    return null;
  }
};
