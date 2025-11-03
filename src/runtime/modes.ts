import { AppConfig } from '../config';
import logger from '../lib/logger';

export type RuntimeMode = 'dry' | 'paper' | 'staging' | 'live';

export interface RuntimeSettings {
  mode: RuntimeMode;
  dryRun: boolean;
  liveTrading: boolean;
  paperTrading: boolean;
  staging: boolean;
}

interface ParsedArgs {
  mode?: RuntimeMode;
  liveFlag: boolean;
  paperOnly: boolean;
  staging: boolean;
  dryRunFlag: boolean;
}

const isRuntimeMode = (value: string): value is RuntimeMode =>
  value === 'dry' || value === 'paper' || value === 'staging' || value === 'live';

const parseArgs = (argv: string[]): ParsedArgs => {
  const result: ParsedArgs = {
    mode: undefined,
    liveFlag: false,
    paperOnly: false,
    staging: false,
    dryRunFlag: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }

    if (arg === '--live') {
      result.liveFlag = true;
      continue;
    }

    if (arg === '--paper-only') {
      result.paperOnly = true;
      result.mode = 'paper';
      continue;
    }

    if (arg === '--staging') {
      result.staging = true;
      result.mode = 'staging';
      continue;
    }

    if (arg === '--dry-run') {
      result.dryRunFlag = true;
      result.mode = 'dry';
      continue;
    }

    if (arg.startsWith('--mode=')) {
      const [, value] = arg.split('=');
      if (value && isRuntimeMode(value)) {
        result.mode = value;
      }
      continue;
    }

    if (arg === '--mode') {
      const next = argv[i + 1];
      if (next && isRuntimeMode(next)) {
        result.mode = next;
        i += 1;
      }
      continue;
    }
  }

  return result;
};

export const resolveRuntimeSettings = (argv: string[], config: AppConfig): RuntimeSettings => {
  const parsed = parseArgs(argv);
  const requestedMode = parsed.mode ?? (config.dryRun ? 'dry' : 'live');

  if (requestedMode === 'live' && !parsed.liveFlag) {
    throw new Error('Live trading mode requires the explicit --live flag acknowledgement.');
  }

  const dryRun = requestedMode !== 'live' || !parsed.liveFlag || parsed.dryRunFlag;

  if (requestedMode === 'live' && dryRun) {
    logger.warn('Live mode requested but dry-run flag detected; proceeding in dry-run mode.');
  }

  const settings: RuntimeSettings = {
    mode: requestedMode,
    dryRun,
    liveTrading: requestedMode === 'live' && !dryRun,
    paperTrading: requestedMode === 'paper',
    staging: requestedMode === 'staging'
  };

  logger.info({
    mode: settings.mode,
    dryRun: settings.dryRun,
    liveTrading: settings.liveTrading,
    paperTrading: settings.paperTrading,
    staging: settings.staging
  }, 'Runtime settings resolved');

  return settings;
};

export const describeRuntimeMode = (settings: RuntimeSettings): string => {
  if (settings.liveTrading) {
    return 'live';
  }
  if (settings.paperTrading) {
    return 'paper';
  }
  if (settings.staging) {
    return 'staging';
  }
  return 'dry';
};
