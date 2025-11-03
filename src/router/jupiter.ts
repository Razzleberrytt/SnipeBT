import axios, { AxiosInstance } from 'axios';
import { PublicKey } from '@solana/web3.js';

import { getConfig } from '../config';

export interface RouteConstraints {
  allowedDexes?: string[];
  deniedDexes?: string[];
  onlyDirectRoutes?: boolean;
}

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  userPublicKey?: string;
  routeConstraints?: RouteConstraints;
}

export interface JupiterRouteMarketInfo {
  label: string;
  inputMint: string;
  outputMint: string;
  notEnoughLiquidity?: boolean;
}

export interface JupiterQuoteRoute {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  marketInfos: JupiterRouteMarketInfo[];
}

export interface QuoteResponse {
  data: JupiterQuoteRoute[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface SwapBuildRequest {
  quote: JupiterQuoteRoute;
  userPublicKey: PublicKey;
  wrapAndUnwrapSol?: boolean;
  computeUnitPriceMicroLamports?: number;
}

export interface SwapBuildResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  lookupTableAddresses?: string[];
}

const createHttpClient = (): AxiosInstance => {
  const config = getConfig();
  return axios.create({
    baseURL: config.jupiter.baseUrl,
    timeout: 10_000
  });
};

const routeMatchesConstraints = (route: JupiterQuoteRoute, constraints?: RouteConstraints): boolean => {
  if (!constraints) {
    return true;
  }

  const labels = route.marketInfos.map((info) => info.label.toLowerCase());

  if (constraints.onlyDirectRoutes && route.marketInfos.length > 1) {
    return false;
  }

  if (constraints.allowedDexes?.length) {
    const allowed = new Set(constraints.allowedDexes.map((dex) => dex.toLowerCase()));
    if (!labels.every((label) => allowed.has(label))) {
      return false;
    }
  }

  if (constraints.deniedDexes?.length) {
    const denied = new Set(constraints.deniedDexes.map((dex) => dex.toLowerCase()));
    if (labels.some((label) => denied.has(label))) {
      return false;
    }
  }

  return true;
};

const selectPreferredRoute = (response: QuoteResponse, constraints?: RouteConstraints): JupiterQuoteRoute | null => {
  if (!response.data || response.data.length === 0) {
    return null;
  }

  const filtered = response.data.filter((route) => routeMatchesConstraints(route, constraints));
  if (filtered.length === 0) {
    return null;
  }

  return filtered[0];
};

export const fetchQuote = async (request: QuoteRequest): Promise<JupiterQuoteRoute | null> => {
  const client = createHttpClient();
  const config = getConfig();

  const params: Record<string, string> = {
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount.toString(),
    slippageBps: request.slippageBps.toString(),
    onlyDirectRoutes: request.routeConstraints?.onlyDirectRoutes ? 'true' : 'false'
  };

  if (request.userPublicKey) {
    params.userPublicKey = request.userPublicKey;
  }

  const { data } = await client.get<QuoteResponse>('/swap/v6/quote', { params });
  const route = selectPreferredRoute(data, request.routeConstraints);
  if (!route) {
    return null;
  }

  logRouteSummary(route, config.risk.slippageBps);
  return route;
};

export const buildSwapTransaction = async (request: SwapBuildRequest): Promise<SwapBuildResponse> => {
  const client = createHttpClient();
  const config = getConfig();

  const payload = {
    quoteResponse: request.quote,
    userPublicKey: request.userPublicKey.toBase58(),
    wrapAndUnwrapSol: request.wrapAndUnwrapSol ?? true,
    computeUnitPriceMicroLamports: request.computeUnitPriceMicroLamports ?? config.risk.maxComputeUnitPrice
  };

  const { data } = await client.post<SwapBuildResponse>('/swap/v6/swap', payload, {
    headers: { 'Content-Type': 'application/json' }
  });

  return data;
};

export const logRouteSummary = (route: JupiterQuoteRoute, maxSlippageBps: number): void => {
  const marketPath = route.marketInfos.map((info) => info.label).join(' -> ');
  const priceImpact = Number(route.priceImpactPct) * 100;
  const minimumOut = Number(route.otherAmountThreshold) / 10 ** 9;
  const outAmount = Number(route.outAmount) / 10 ** 9;

  console.info(
    `Jupiter route selected: ${marketPath} | est out: ${outAmount.toFixed(6)} | min out @ ${maxSlippageBps}bps: ${minimumOut.toFixed(6)} | price impact: ${priceImpact.toFixed(2)}%`
  );
};
