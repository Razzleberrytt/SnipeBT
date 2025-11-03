import { AppConfig } from '../config';

import { resolveRuntimeSettings } from './modes';

const baseConfig = ({ dryRun = true }: { dryRun?: boolean } = {}): AppConfig => ({
  rpc: { primary: 'https://primary.rpc', backups: ['https://backup.rpc'] },
  jupiter: { baseUrl: 'https://jupiter.test' },
  risk: { slippageBps: 50, maxRiskPct: 20, maxPositionPct: 10, maxComputeUnitPrice: 10_000 },
  telegram: { enabled: false },
  secrets: { provider: 'local' },
  dataDir: '/tmp',
  dryRun,
  metrics: { port: 9464 }
});

describe('resolveRuntimeSettings', () => {
  it('defaults to dry mode when config specifies dry run', () => {
    const config = baseConfig();
    const settings = resolveRuntimeSettings([], config);
    expect(settings.mode).toBe('dry');
    expect(settings.dryRun).toBe(true);
    expect(settings.liveTrading).toBe(false);
  });

  it('throws if live mode requested without --live acknowledgement', () => {
    const config = baseConfig({ dryRun: false });
    expect(() => resolveRuntimeSettings(['--mode', 'live'], config)).toThrow('Live trading mode requires');
  });

  it('enables live trading when mode is live and flag provided', () => {
    const config = baseConfig({ dryRun: false });
    const settings = resolveRuntimeSettings(['--mode', 'live', '--live'], config);
    expect(settings.mode).toBe('live');
    expect(settings.dryRun).toBe(false);
    expect(settings.liveTrading).toBe(true);
  });

  it('forces dry run when dry-run flag present even in live mode', () => {
    const config = baseConfig({ dryRun: false });
    const settings = resolveRuntimeSettings(['--mode', 'live', '--live', '--dry-run'], config);
    expect(settings.mode).toBe('live');
    expect(settings.dryRun).toBe(true);
    expect(settings.liveTrading).toBe(false);
  });

  it('recognizes paper trading mode', () => {
    const config = baseConfig({ dryRun: false });
    const settings = resolveRuntimeSettings(['--paper-only'], config);
    expect(settings.mode).toBe('paper');
    expect(settings.paperTrading).toBe(true);
    expect(settings.dryRun).toBe(true);
  });
});
