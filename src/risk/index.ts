import { Connection, ParsedAccountData, PublicKey } from '@solana/web3.js';

import { getConfig } from '../config';

export class RiskError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RiskError';
  }
}

export interface PortfolioPosition {
  mint: string;
  notionalUsd: number;
}

export interface PortfolioSnapshot {
  totalEquityUsd: number;
  positions: PortfolioPosition[];
}

export interface TradeIntent {
  mint: string;
  notionalUsd: number;
  slippageBps: number;
  computeUnitPrice: number;
  creator?: string | null;
  liquidityUsd?: number | null;
}

export interface RiskCheckOptions {
  minLiquidityUsd?: number;
}

const DEFAULT_MIN_LIQUIDITY_USD = 10_000;

interface DenyLists {
  mints: Set<string>;
  creators: Set<string>;
}

const denyLists: DenyLists = {
  mints: new Set<string>(),
  creators: new Set<string>()
};

export const addDeniedMint = (mint: string) => denyLists.mints.add(mint);
export const addDeniedCreator = (creator: string) => denyLists.creators.add(creator);
export const clearDenyLists = () => {
  denyLists.mints.clear();
  denyLists.creators.clear();
};

export const getDenyLists = (): { mints: string[]; creators: string[] } => ({
  mints: Array.from(denyLists.mints),
  creators: Array.from(denyLists.creators)
});

export const isMintDenied = (mint: string): boolean => denyLists.mints.has(mint);
export const isCreatorDenied = (creator: string | null | undefined): boolean =>
  creator ? denyLists.creators.has(creator) : false;

export const assertRiskCompliance = (
  intent: TradeIntent,
  snapshot: PortfolioSnapshot,
  options: RiskCheckOptions = {}
): void => {
  const config = getConfig();

  if (intent.notionalUsd <= 0) {
    throw new RiskError('InvalidNotional', 'Trade intent notional must be positive.');
  }

  if (snapshot.totalEquityUsd <= 0) {
    throw new RiskError('InvalidEquity', 'Total equity must be greater than zero to evaluate risk.');
  }

  if (isMintDenied(intent.mint)) {
    throw new RiskError('MintDenied', `Mint ${intent.mint} is deny-listed.`);
  }

  if (isCreatorDenied(intent.creator)) {
    throw new RiskError('CreatorDenied', `Creator ${intent.creator} is deny-listed.`);
  }

  if (intent.slippageBps > config.risk.slippageBps) {
    throw new RiskError(
      'SlippageExceeded',
      `Requested slippage ${intent.slippageBps}bps exceeds configured maximum of ${config.risk.slippageBps}bps.`
    );
  }

  if (intent.computeUnitPrice > config.risk.maxComputeUnitPrice) {
    throw new RiskError(
      'ComputeUnitPriceExceeded',
      `Requested compute unit price ${intent.computeUnitPrice} exceeds limit ${config.risk.maxComputeUnitPrice}.`
    );
  }

  const minLiquidity = options.minLiquidityUsd ?? DEFAULT_MIN_LIQUIDITY_USD;
  if (intent.liquidityUsd !== undefined && intent.liquidityUsd !== null && intent.liquidityUsd < minLiquidity) {
    throw new RiskError(
      'LiquidityTooLow',
      `Available liquidity ${intent.liquidityUsd} USD is below required minimum ${minLiquidity} USD.`
    );
  }

  const totalExposure = snapshot.positions.reduce((sum, position) => sum + position.notionalUsd, 0);
  const proposedTotal = totalExposure + intent.notionalUsd;
  const maxExposure = (config.risk.maxRiskPct / 100) * snapshot.totalEquityUsd;
  if (proposedTotal > maxExposure) {
    throw new RiskError(
      'GlobalExposureExceeded',
      `Proposed exposure ${proposedTotal.toFixed(2)} exceeds max allowed ${maxExposure.toFixed(2)}.`
    );
  }

  const existingPosition = snapshot.positions.find((position) => position.mint === intent.mint);
  const currentExposure = existingPosition?.notionalUsd ?? 0;
  const proposedPositionExposure = currentExposure + intent.notionalUsd;
  const maxPositionExposure = (config.risk.maxPositionPct / 100) * snapshot.totalEquityUsd;
  if (proposedPositionExposure > maxPositionExposure) {
    throw new RiskError(
      'PositionExposureExceeded',
      `Position exposure ${proposedPositionExposure.toFixed(2)} exceeds max allowed ${maxPositionExposure.toFixed(2)}.`
    );
  }
};

export interface TokenMintInfo {
  mint: string;
  decimals: number;
  supply: bigint;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  isInitialized: boolean;
}

export interface TokenSafetyCheckResult {
  info: TokenMintInfo;
  warnings: string[];
  isSafe: boolean;
}

export interface TokenSafetyOptions {
  requireFreezeAuthorityRenounced?: boolean;
  requireMintAuthorityRenounced?: boolean;
}

export const fetchTokenMintInfo = async (
  connection: Connection,
  mintAddress: string
): Promise<TokenMintInfo> => {
  const publicKey = new PublicKey(mintAddress);
  const accountInfo = await connection.getParsedAccountInfo(publicKey);

  if (!accountInfo.value) {
    throw new RiskError('MintNotFound', `Mint account ${mintAddress} not found.`);
  }

  const data = accountInfo.value.data as ParsedAccountData;
  if (!('parsed' in data)) {
    throw new RiskError('UnsupportedAccountFormat', 'Unable to parse mint account data.');
  }

  const parsed = data.parsed.info as Record<string, unknown>;
  const freezeAuthority = (parsed.freezeAuthority as string | null | undefined) ?? null;
  const mintAuthority = (parsed.mintAuthority as string | null | undefined) ?? null;
  const decimals = Number(parsed.decimals ?? 0);
  const supplyRaw = (parsed.supply as string | undefined) ?? '0';
  const isInitialized = Boolean(parsed.isInitialized ?? false);

  return {
    mint: mintAddress,
    decimals,
    supply: BigInt(supplyRaw),
    freezeAuthority,
    mintAuthority,
    isInitialized
  };
};

export const validateTokenSafety = async (
  connection: Connection,
  mintAddress: string,
  options: TokenSafetyOptions = {}
): Promise<TokenSafetyCheckResult> => {
  const info = await fetchTokenMintInfo(connection, mintAddress);
  const warnings: string[] = [];

  if (options.requireFreezeAuthorityRenounced !== false && info.freezeAuthority) {
    warnings.push(`Freeze authority still present (${info.freezeAuthority}).`);
  }

  if (options.requireMintAuthorityRenounced !== false && info.mintAuthority) {
    warnings.push(`Mint authority still present (${info.mintAuthority}).`);
  }

  if (!info.isInitialized) {
    warnings.push('Mint is not initialized.');
  }

  return {
    info,
    warnings,
    isSafe: warnings.length === 0
  };
};
