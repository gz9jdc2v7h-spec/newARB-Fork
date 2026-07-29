import { ethers } from "ethers";
import { ROUTING_MAX_HOPS, TOKENS } from "../config";
import type { PairQuotes } from "../discovery/OpportunityScanner";
import type { PriceQuote } from "../discovery/PriceFeeder";
import type { ArbPath } from "../math/BellmanFord";

export interface MultiHopStep {
  tokenIn: string;
  tokenOut: string;
  dex: string;
  price: number;
  amountIn: string;
  expectedOut: string;
}

export interface ExecutableMultiHopRoute {
  routeId: string;
  tokens: string[];
  dexes: string[];
  grossFactor: number;
  expectedStartAmountIn: string;
  expectedFinalAmountOut: string;
  steps: MultiHopStep[];
  valid: boolean;
  rejectionReason?: string;
  quoteAgeMs: number;
}

export function buildExecutableMultiHopRoutes(
  snapshot: PairQuotes[],
  paths: ArbPath[],
  amountIn: bigint,
  maxHops = ROUTING_MAX_HOPS
): ExecutableMultiHopRoute[] {
  if (amountIn <= 0n) return [];

  const quoteMap = new Map<string, PriceQuote[]>();
  for (const pair of snapshot) {
    quoteMap.set(`${pair.tokenIn}/${pair.tokenOut}`, pair.quotes);
  }

  const routes: ExecutableMultiHopRoute[] = [];
  for (const path of paths) {
    const hops = path.tokens.length - 1;
    if (hops < 2 || hops > maxHops) continue;

    const firstToken = path.tokens[0];
    const lastToken = path.tokens[path.tokens.length - 1];
    if (!firstToken || !lastToken || firstToken !== lastToken) continue;

    let valid = true;
    let rejectionReason: string | undefined;
    let amountNorm = Number(ethers.formatUnits(amountIn, TOKENS[firstToken]?.decimals ?? 18));
    const steps: MultiHopStep[] = [];
    let oldestQuoteTs = Date.now();

    for (let i = 0; i < hops; i++) {
      const tokenIn = path.tokens[i]!;
      const tokenOut = path.tokens[i + 1]!;
      const dex = path.dexes[i]!;

      const quotes = quoteMap.get(`${tokenIn}/${tokenOut}`) ?? [];
      const quote = quotes.find((q) => q.dex === dex);
      if (!quote || quote.price <= 0) {
        valid = false;
        rejectionReason = `missing_quote:${tokenIn}/${tokenOut}@${dex}`;
        break;
      }

      oldestQuoteTs = Math.min(oldestQuoteTs, quote.timestamp);
      const inAmountNorm = amountNorm;
      amountNorm *= quote.price;
      if (!isFinite(amountNorm) || amountNorm <= 0) {
        valid = false;
        rejectionReason = `invalid_projection:${tokenIn}/${tokenOut}@${dex}`;
        break;
      }

      const outDecimals = TOKENS[tokenOut]?.decimals ?? 18;
      const inDecimals = TOKENS[tokenIn]?.decimals ?? 18;
      const amountInRaw = ethers.parseUnits(inAmountNorm.toFixed(Math.min(inDecimals, 12)), inDecimals);
      const expectedOutRaw = ethers.parseUnits(amountNorm.toFixed(Math.min(outDecimals, 12)), outDecimals);

      steps.push({
        tokenIn,
        tokenOut,
        dex,
        price: quote.price,
        amountIn: amountInRaw.toString(),
        expectedOut: expectedOutRaw.toString(),
      });
    }

    if (valid) {
      const outDecimals = TOKENS[lastToken]?.decimals ?? 18;
      const expectedFinalAmountOut = ethers
        .parseUnits(amountNorm.toFixed(Math.min(outDecimals, 12)), outDecimals)
        .toString();

      routes.push({
        routeId: `${path.tokens.join("->")}|${path.dexes.join("->")}`,
        tokens: [...path.tokens],
        dexes: [...path.dexes],
        grossFactor: path.grossFactor,
        expectedStartAmountIn: amountIn.toString(),
        expectedFinalAmountOut,
        steps,
        valid: true,
        quoteAgeMs: Date.now() - oldestQuoteTs,
      });
      continue;
    }

    routes.push({
      routeId: `${path.tokens.join("->")}|${path.dexes.join("->")}`,
      tokens: [...path.tokens],
      dexes: [...path.dexes],
      grossFactor: path.grossFactor,
      expectedStartAmountIn: amountIn.toString(),
      expectedFinalAmountOut: "0",
      steps,
      valid: false,
      rejectionReason,
      quoteAgeMs: Date.now() - oldestQuoteTs,
    });
  }

  routes.sort((a, b) => {
    if (a.valid !== b.valid) return a.valid ? -1 : 1;
    return b.grossFactor - a.grossFactor;
  });

  return routes;
}
