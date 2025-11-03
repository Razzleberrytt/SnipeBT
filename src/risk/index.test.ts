import { resetConfig } from '../config';
import {
  RiskError,
  addDeniedMint,
  assertRiskCompliance,
  clearDenyLists,
  PortfolioSnapshot,
  TradeIntent
} from './index';

beforeAll(() => {
  process.env.RPC_PRIMARY = 'https://primary.example.com';
  process.env.RPC_BACKUP = 'https://backup.example.com';
  process.env.JUPITER_BASE_URL = 'https://quote-api.jup.ag';
  process.env.SLIPPAGE_BPS = '50';
  process.env.MAX_RISK_PCT = '25';
  process.env.MAX_POS_PCT = '10';
  process.env.MAX_CU_PRICE = '10000';
  process.env.DATA_DIR = './data-test';
  process.env.DRY_RUN = 'true';
});

beforeEach(() => {
  clearDenyLists();
  resetConfig();
});

describe('Risk manager', () => {
  const snapshot: PortfolioSnapshot = {
    totalEquityUsd: 10_000,
    positions: [
      { mint: 'AAA', notionalUsd: 500 },
      { mint: 'BBB', notionalUsd: 750 }
    ]
  };

  it('enforces global exposure cap', () => {
    const intent: TradeIntent = {
      mint: 'CCC',
      notionalUsd: 2_500,
      slippageBps: 25,
      computeUnitPrice: 5_000
    };

    expect(() => assertRiskCompliance(intent, snapshot)).toThrowError(RiskError);
  });

  it('enforces per-position cap', () => {
    const intent: TradeIntent = {
      mint: 'AAA',
      notionalUsd: 900,
      slippageBps: 10,
      computeUnitPrice: 1_000
    };

    expect(() => assertRiskCompliance(intent, snapshot)).toThrowError(RiskError);
  });

  it('respects deny-listed mints', () => {
    addDeniedMint('DDD');
    const intent: TradeIntent = {
      mint: 'DDD',
      notionalUsd: 100,
      slippageBps: 5,
      computeUnitPrice: 500
    };

    expect(() => assertRiskCompliance(intent, snapshot)).toThrowError(RiskError);
  });

  it('allows compliant intent', () => {
    const intent: TradeIntent = {
      mint: 'EEE',
      notionalUsd: 500,
      slippageBps: 20,
      computeUnitPrice: 5_000,
      liquidityUsd: 25_000
    };

    expect(() => assertRiskCompliance(intent, snapshot)).not.toThrow();
  });
});
