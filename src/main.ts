import { loadConfig } from './config';
import logger from './lib/logger';
import { ApplicationRuntime } from './runtime/application';
import { resolveRuntimeSettings } from './runtime/modes';

process.on('unhandledRejection', (error) => {
  logger.error({ err: error }, 'Unhandled promise rejection');
  process.exitCode = 1;
});

process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught exception');
  process.exitCode = 1;
});

const registerShutdown = (runtime: ApplicationRuntime) => {
  const handleSignal = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'Received shutdown signal');
    runtime
      .stop()
      .catch((error) => {
        logger.error({ err: error }, 'Failed to shutdown runtime cleanly');
      })
      .finally(() => process.exit(0));
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
};

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const settings = resolveRuntimeSettings(process.argv.slice(2), config);

  const runtime = new ApplicationRuntime(config, settings);
  registerShutdown(runtime);

  await runtime.start();

  logger.info('Runtime bootstrapped. Awaiting tasks.');
}

void bootstrap().catch((error) => {
  logger.fatal({ err: error }, 'Fatal error during bootstrap');
  process.exit(1);
});
