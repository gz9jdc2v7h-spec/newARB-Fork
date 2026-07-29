import { ethers } from "ethers";
import { PairQuotes } from "../discovery/OpportunityScanner";
import { PriceQuote, fetchQuote } from "../discovery/PriceFeeder";
import { GasData, getGasData, estimateGasCostUsd } from "./GasEstimator";
import { toFloat } from "../utils/helpers";
import { TOKENS, MIN_PROFIT_USD, MAX_SLIPPAGE, DEXES } from "../config";
import { logger } from "../utils/logger";
import {
  cfmmOptimalInput,
  cfmmAmountOut,
  cfmmArbProfit,
  cfmmPriceImpact,
  cfmmLiquidityDepth,
} from "../math/CfmmMath";
import { findArbitragePaths, cycleKey, ArbPath } from "../math/BellmanFord";
import { kellyScore } from "../math/KellyCriterion";
import { EmaTracker, classifyRegime } from "../math/EmaTracker";
import { selectOptimalPortfolio, PortfolioSelection } from "../math/QuantumSelector";
import {
  buildExecutableMultiHopRoutes,
  ExecutableMultiHopRoute,
} from "../routing/MultiHopRouter";

// Preserve at least 10% of the raw Kelly score so shallow pools are penalized
// without collapsing otherwise-profitable opportunities to zero.
const MIN_DEPTH_PENALTY = 0.1;

export interface ArbitrageOpportunity {
  /** Human-readable description */
  label: string;
  /** Buy on this DEX (lower price) */
  buyQuote: PriceQuote;
  /** Sell on this DEX (higher price) */
  sellQuote: PriceQuote;
  tokenBase: string;
  tokenQuote: string;
  /** Optimal trade size in tokenBase units (raw BigInt) */
  tradeAmountIn: bigint;
  /** Expected gross profit in USD */
  grossProfitUsd: number;
  /** Estimated gas cost in USD */
  gasCostUsd: number;
  /** Expected net profit in USD */
  netProfitUsd: number;
  /**
   * Actual capital deployed for the trade in USD (tradeAmountIn × input token price).
   * Used by Kelly scoring and portfolio optimisation — not an estimate.
   */
  tradeAmountInUsd: number;
  /**
   * Kelly-adjusted risk score (higher = better risk-adjusted return).
   * Replaces the simple profit-to-gas ratio with a rigorous utility-maximising
   * score derived from the Kelly criterion.
   */
  score: number;
  /** Price impact on the buy leg (0–1). */
  priceImpactBuy: number;
  /** Price impact on the sell leg (0–1). */
  priceImpactSell: number;
  /** True if this opportunity is part of a detected Bellman–Ford cycle. */
  isMultiHop: boolean;
  /** Oldest quote age across both legs. */
  quoteAgeMs: number;
  /** How the trade size was derived. */
  sizingMethod: "cfmm_closed_form" | "spread_scaled";
  /** Invariant families used by the route. */
  invariantFamilies: string[];
  /** Route shape for downstream execution policy. */
  routeKind: "two_leg" | "multi_hop";
  /** Fully constructed route if multi-hop execution is available. */
  multiHopRoute?: ExecutableMultiHopRoute;
}

// ─── Token price oracle (derived from snapshot) ───────────────────────────────

/**
 * Derive the ETH/USD price from the snapshot (weighted average over all
 * WETH→stablecoin quotes).
 */
function ethPriceUsd(snapshot: PairQuotes[]): number {
  let sum = 0;
  let count = 0;
  for (const pair of snapshot) {
    if (
      pair.tokenIn === "WETH" &&
      (pair.tokenOut === "USDC" || pair.tokenOut === "USDT" || pair.tokenOut === "DAI")
    ) {
      for (const q of pair.quotes) {
        sum += q.price;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 3_000;
}

/**
 * Build a symbol → USD price map for every token in the snapshot.
 *
 * Resolution order (highest priority first):
 *   1. Hard-coded: WETH=ethUsd, USDC/USDT/DAI=1.0
 *   2. Derived from a tokenIn/WETH pair:  price_usd = quote.price × ethUsd
 *   3. Derived from a tokenIn/stablecoin pair: price_usd = quote.price × stablecoin_price
 *
 * This correctly prices WBTC, WMATIC and any other token present in the snapshot
 * instead of treating their raw units as dollars.
 */
function buildTokenPricesUsd(snapshot: PairQuotes[], ethUsd: number): Map<string, number> {
  const prices = new Map<string, number>([
    ["WETH", ethUsd],
    ["ETH",  ethUsd],
    ["USDC", 1.0],
    ["USDT", 1.0],
    ["DAI",  1.0],
  ]);

  for (const pair of snapshot) {
    if (prices.has(pair.tokenIn) || pair.quotes.length === 0) continue;
    const avgPrice =
      pair.quotes.reduce((s, q) => s + q.price, 0) / pair.quotes.length;

    if (pair.tokenOut === "WETH" || pair.tokenOut === "ETH") {
      // avgPrice = (tokenOut normalised) / (tokenIn normalised) = WETH per tokenIn
      prices.set(pair.tokenIn, avgPrice * ethUsd);
    } else {
      const quoteTokenPrice = prices.get(pair.tokenOut);
      if (quoteTokenPrice !== undefined) {
        // avgPrice = (stablecoin) / (tokenIn) → USD per tokenIn
        prices.set(pair.tokenIn, avgPrice * quoteTokenPrice);
      }
    }
  }

  return prices;
}

// ─── Optimal trade sizing ─────────────────────────────────────────────────────

/**
 * Compute the optimal input amount for a cross-DEX arbitrage.
 *
 * Strategy:
 *   1. If both quotes are UniV2 (reserves available): use the closed-form
 *      calculus solution x* = (√(A·B) − B) / C (see CfmmMath.ts).
 *   2. If at least one leg is UniV3 (no reserves): use a conservative
 *      fraction of the quoted amount, scaled by the price spread.
 *
 * Correct pool layout for the profitable direction (A→B→A round-trip):
 *   Sell tokenIn on the HIGHER-price DEX (sellQuote) first — Pool 1.
 *   Buy tokenIn back on the LOWER-price DEX (buyQuote) second — Pool 2 (reversed).
 *
 *   Pool 1: r1 = sellQuote.reserveIn  (tokenIn  reserve of high-price pool)
 *           s1 = sellQuote.reserveOut (tokenOut reserve of high-price pool)
 *   Pool 2: r2 = buyQuote.reserveOut  (tokenOut reserve of low-price pool)
 *           s2 = buyQuote.reserveIn   (tokenIn  reserve of low-price pool)
 */
function computeOptimalInput(
  buyQuote: PriceQuote,
  sellQuote: PriceQuote
): {
  amountIn: bigint;
  sizingMethod: "cfmm_closed_form" | "spread_scaled";
} {
  const hasBuyReserves =
    buyQuote.reserveIn !== undefined &&
    buyQuote.reserveOut !== undefined &&
    buyQuote.feeBps !== undefined;
  const hasSellReserves =
    sellQuote.reserveIn !== undefined &&
    sellQuote.reserveOut !== undefined &&
    sellQuote.feeBps !== undefined;

  if (hasBuyReserves && hasSellReserves) {
    // Closed-form x* from CfmmMath.
    // Pool 1 (sell tokenIn for tokenOut on high-price DEX):
    //   r1 = sellQuote.reserveIn, s1 = sellQuote.reserveOut
    // Pool 2 (buy tokenIn back with tokenOut on low-price DEX):
    //   r2 = buyQuote.reserveOut, s2 = buyQuote.reserveIn
    const x = cfmmOptimalInput(
      sellQuote.reserveIn!,
      sellQuote.reserveOut!,
      sellQuote.feeBps!,
      buyQuote.reserveOut!,
      buyQuote.reserveIn!,
      buyQuote.feeBps!
    );
    // Verify the profit is positive at x* (guards against edge cases)
    if (x > 0n) {
      const profit = cfmmArbProfit(
        x,
        sellQuote.reserveIn!,
        sellQuote.reserveOut!,
        sellQuote.feeBps!,
        buyQuote.reserveOut!,
        buyQuote.reserveIn!,
        buyQuote.feeBps!
      );
      if (profit > 0n) {
        return { amountIn: x, sizingMethod: "cfmm_closed_form" };
      }
    }
  }

  // Fallback: spread-proportional fraction of quoted amount.
  const spread = (sellQuote.price - buyQuote.price) / buyQuote.price;
  if (spread <= 0) return { amountIn: 0n, sizingMethod: "spread_scaled" };

  // Conservative cap: 60 % of quoted amount, scaled by spread magnitude
  const factor = Math.min(0.6 + spread * 4, 1.0);
  return {
    amountIn: BigInt(Math.floor(Number(sellQuote.amountIn) * factor)),
    sizingMethod: "spread_scaled",
  };
}

// ─── Exact two-leg profit from real on-chain data ────────────────────────────

/**
 * Compute the exact gross profit of a two-leg round-trip at `tradeAmountIn`.
 *
 * Leg 1: sell tokenIn on the HIGH-price DEX (sellQuote).
 * Leg 2: buy tokenIn back on the LOW-price DEX (buyQuote) using tokenOut received.
 *
 * UniV2 legs: exact CFMM formula using on-chain reserves (no RPC call).
 * UniV3 legs: re-queries the on-chain quoter at the actual trade amount.
 *
 * @returns Exact profit in raw tokenIn units, or 0n if unprofitable / query fails.
 */
async function computeExactProfit(
  provider: ethers.Provider,
  buyQuote: PriceQuote,
  sellQuote: PriceQuote,
  tradeAmountIn: bigint
): Promise<bigint> {
  const hasBuyReserves =
    buyQuote.reserveIn !== undefined &&
    buyQuote.reserveOut !== undefined &&
    buyQuote.feeBps !== undefined;
  const hasSellReserves =
    sellQuote.reserveIn !== undefined &&
    sellQuote.reserveOut !== undefined &&
    sellQuote.feeBps !== undefined;

  // ── UniV2 / UniV2: fully exact via CFMM reserves, zero extra RPC calls ────
  if (hasBuyReserves && hasSellReserves) {
    return cfmmArbProfit(
      tradeAmountIn,
      sellQuote.reserveIn!,  sellQuote.reserveOut!, sellQuote.feeBps!,
      buyQuote.reserveOut!,  buyQuote.reserveIn!,   buyQuote.feeBps!
    );
  }

  // ── At least one UniV3 leg: re-query quoter at actual trade size ──────────

  // Leg 1: sell tradeAmountIn of tokenIn on sellQuote DEX → get tokenOut
  let leg1Out: bigint;
  if (hasSellReserves) {
    // UniV2 sell leg — exact CFMM, no RPC
    leg1Out = cfmmAmountOut(
      sellQuote.reserveIn!, sellQuote.reserveOut!, tradeAmountIn, sellQuote.feeBps!
    );
  } else {
    // UniV3 sell leg — re-quote at actual size on-chain
    const dex = DEXES.find((d) => d.name === sellQuote.dex);
    if (!dex) return 0n;
    const q = await fetchQuote(provider, dex, sellQuote.tokenIn, sellQuote.tokenOut, tradeAmountIn);
    if (!q || q.amountOut === 0n) return 0n;
    leg1Out = q.amountOut;
  }
  if (leg1Out === 0n) return 0n;

  // Leg 2: sell leg1Out of tokenOut on buyQuote DEX → get tokenIn back
  let leg2Out: bigint;
  if (hasBuyReserves) {
    // UniV2 buy leg (reverse direction) — exact CFMM, no RPC
    // reserveOut is the tokenOut side of the pool; reserveIn is the tokenIn side.
    leg2Out = cfmmAmountOut(
      buyQuote.reserveOut!, buyQuote.reserveIn!, leg1Out, buyQuote.feeBps!
    );
  } else {
    // UniV3 buy leg — re-quote the reverse direction (tokenOut → tokenIn) on-chain
    const dex = DEXES.find((d) => d.name === buyQuote.dex);
    if (!dex) return 0n;
    const q = await fetchQuote(provider, dex, buyQuote.tokenOut, buyQuote.tokenIn, leg1Out);
    if (!q || q.amountOut === 0n) return 0n;
    leg2Out = q.amountOut;
  }

  return leg2Out > tradeAmountIn ? leg2Out - tradeAmountIn : 0n;
}

// ─── Ranker ───────────────────────────────────────────────────────────────────

export class OpportunityRanker {
  private provider: ethers.Provider;
  private emaTracker: EmaTracker;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
    this.emaTracker = new EmaTracker();
  }

  async rank(snapshot: PairQuotes[]): Promise<ArbitrageOpportunity[]> {
    const gasData = await getGasData(this.provider);
    const ethUsd = ethPriceUsd(snapshot);
    const tokenPrices = buildTokenPricesUsd(snapshot, ethUsd);

    // Feed EMA tracker with latest prices
    this.updateEmaTracker(snapshot);

    // Run Bellman–Ford to find multi-hop cycles (informs scoring bonus)
    const arbPaths = findArbitragePaths(snapshot);
    const multiHopKeys = new Set(arbPaths.map((p) => cycleKey(p.tokens)));
    const executableRoutes = buildExecutableMultiHopRoutes(
      snapshot,
      arbPaths,
      ethers.parseEther("1")
    );
    const routesByCycleKey = new Map<string, ExecutableMultiHopRoute[]>();
    for (const route of executableRoutes) {
      if (!route.valid) continue;
      const key = cycleKey(route.tokens);
      const arr = routesByCycleKey.get(key) ?? [];
      arr.push(route);
      routesByCycleKey.set(key, arr);
    }

    // Enumerate two-pool opportunities across all pairs in parallel
    const oppArrays = await Promise.all(
      snapshot.map((pairData) =>
        this.findOpportunities(
          pairData,
          gasData,
          ethUsd,
          multiHopKeys,
          tokenPrices,
          routesByCycleKey
        )
      )
    );
    const opportunities = oppArrays.flat();

    // Sort by Kelly score descending (Kelly score = risk-adjusted return)
    opportunities.sort((a, b) => b.score - a.score);

    if (opportunities.length > 0) {
      logger.info(`Ranked ${opportunities.length} opportunity/ies`, {
        best: opportunities[0]!.label,
        netProfitUsd: opportunities[0]!.netProfitUsd.toFixed(2),
        kellyScore: opportunities[0]!.score.toFixed(4),
        multiHopCycles: arbPaths.length,
      });
    }

    return opportunities;
  }

  /**
   * Select the best portfolio of opportunities within a capital budget using
   * quantum-inspired simulated annealing (QUBO solver).
   *
   * Call this after `rank()` when you want to trade multiple opportunities
   * simultaneously with a shared capital constraint.
   */
  selectPortfolio(
    rankedOpportunities: ArbitrageOpportunity[],
    budgetUsd: number,
    ethUsd: number
  ): PortfolioSelection {
    return selectOptimalPortfolio(rankedOpportunities, budgetUsd, ethUsd);
  }

  // ─── EMA tracker feed ──────────────────────────────────────────────────────

  private updateEmaTracker(snapshot: PairQuotes[]): void {
    for (const pair of snapshot) {
      if (pair.quotes.length < 2) continue;
      const prices = pair.quotes.map((q) => q.price);
      const midPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const spread = minPrice > 0 ? (maxPrice - minPrice) / minPrice : 0;
      this.emaTracker.update(pair.tokenIn, pair.tokenOut, midPrice, spread);
    }
  }

  // ─── Two-pool opportunity search ─────────────────────────────────────────

  private async findOpportunities(
    pairData: PairQuotes,
    gasData: GasData,
    ethUsd: number,
    multiHopKeys: Set<string>,
    tokenPrices: Map<string, number>,
    routesByCycleKey: Map<string, ExecutableMultiHopRoute[]>
  ): Promise<ArbitrageOpportunity[]> {
    const { tokenIn, tokenOut, quotes } = pairData;
    if (quotes.length < 2) return [];

    // Fetch EMA-based stats for adaptive spread threshold
    const pairStats = this.emaTracker.getStats(tokenIn, tokenOut);
    const regime = pairStats ? classifyRegime(pairStats.dailyVolatility) : "normal";
    const minSpread = this.emaTracker.adjustedMinSpread(tokenIn, tokenOut, MAX_SLIPPAGE * 2);

    const results: ArbitrageOpportunity[] = [];

    for (let i = 0; i < quotes.length; i++) {
      for (let j = i + 1; j < quotes.length; j++) {
        const a = quotes[i]!;
        const b = quotes[j]!;

        // Identify buy (lower price) and sell (higher price) sides
        const [buyQuote, sellQuote] = a.price < b.price ? [a, b] : [b, a];

        const spread = (sellQuote.price - buyQuote.price) / buyQuote.price;

        // Adaptive spread filter: use EMA-based Bollinger threshold when warm,
        // otherwise fall back to 2× slippage floor.
        if (spread < minSpread) continue;

        // In extreme volatility regimes, require a larger spread buffer
        if (regime === "extreme" && spread < MAX_SLIPPAGE * 4) continue;

        // ── Closed-form or spread-proportional optimal trade size ──────────
        const { amountIn: tradeAmountIn, sizingMethod } = computeOptimalInput(
          buyQuote,
          sellQuote
        );
        if (tradeAmountIn === 0n) continue;

        const tokenInCfg = TOKENS[tokenIn];
        if (!tokenInCfg) continue;

        // ── Exact gross profit from real on-chain data ─────────────────────
        // UniV2/UniV2: uses CFMM reserves directly (no extra RPC call).
        // Any UniV3 leg: re-queries the on-chain quoter at the actual trade size.
        // This is the only value feeding the final MIN_PROFIT_USD gate.
        const grossProfitRaw = await computeExactProfit(
          this.provider, buyQuote, sellQuote, tradeAmountIn
        );
        if (grossProfitRaw <= 0n) continue;

        // Convert exact raw profit to USD using the per-token price oracle.
        // This correctly handles WETH, stablecoins, WBTC, WMATIC and any other
        // token present in the snapshot — previous code wrongly fell back to
        // treating non-WETH token units as dollars.
        const tokenInPriceUsd = tokenPrices.get(tokenIn);
        // Skip if we cannot price the input token — an assumed price would
        // corrupt the profit gate and Kelly score.
        if (tokenInPriceUsd === undefined) continue;
        const grossProfitUsd =
          toFloat(grossProfitRaw, tokenInCfg.decimals) * tokenInPriceUsd;

        // Gas cost
        const totalGasUnits = buyQuote.gasEstimate + sellQuote.gasEstimate;
        const gasCostUsd = estimateGasCostUsd(totalGasUnits, gasData, ethUsd);

        const netProfitUsd = grossProfitUsd - gasCostUsd;
        if (netProfitUsd < MIN_PROFIT_USD) continue;

        // ── Price impact on each leg (from CfmmMath) ──────────────────────
        const priceImpactBuy =
          buyQuote.reserveIn !== undefined && buyQuote.feeBps !== undefined
            ? cfmmPriceImpact(buyQuote.reserveIn, tradeAmountIn, buyQuote.feeBps)
            : spread / 2;
        const priceImpactSell =
          sellQuote.reserveIn !== undefined && sellQuote.feeBps !== undefined
            ? cfmmPriceImpact(sellQuote.reserveIn, tradeAmountIn, sellQuote.feeBps)
            : spread / 2;

        // ── Actual capital deployed for Kelly & portfolio scoring ─────────
        // tradeAmountIn × per-token USD price — correct for all token types.
        const tradeAmountInNormalized = Number(tradeAmountIn) / 10 ** tokenInCfg.decimals;
        const tradeAmountInUsd = tradeAmountInNormalized * tokenInPriceUsd;
        // capitalUsd = actual capital deployed (not inflated by gas cost)
        const capitalUsd = tradeAmountInUsd;

        // ── Liquidity depth penalty ───────────────────────────────────────
        const buyDepthUsd =
          buyQuote.reserveIn !== undefined
            ? cfmmLiquidityDepth(
                buyQuote.reserveIn,
                tokenInCfg.decimals,
                tokenInPriceUsd,
              )
            : Number.POSITIVE_INFINITY;
        // Penalize shallow pools exponentially: once deployed capital grows
        // toward the buy-side liquidity depth, the Kelly score decays quickly
        // to reflect higher price-impact and execution-risk exposure.
        const depthPenalty =
          Number.isFinite(buyDepthUsd) && buyDepthUsd > 0
            ? Math.max(
                MIN_DEPTH_PENALTY,
                Math.exp(-capitalUsd / buyDepthUsd),
              )
            : 1;

        // ── Kelly risk-adjusted score ─────────────────────────────────────
        const volatilityFactor = pairStats ? 1 + pairStats.dailyVolatility * 10 : 1;
        const baseScore = kellyScore(netProfitUsd, gasCostUsd, capitalUsd, 0.88, volatilityFactor);
        const depthAdjustedScore = baseScore * depthPenalty;

        // ── Multi-hop bonus: confirmed Bellman–Ford cycle → +15 % score ───
        const pairKey = cycleKey([tokenIn, tokenOut]);
        const selectedRoute = Array.from(routesByCycleKey.entries())
          .filter(([k]) => k.includes(tokenIn) && k.includes(tokenOut))
          .flatMap(([, routes]) => routes)
          .find((route) => route.valid);
        const isMultiHop = Boolean(selectedRoute) || multiHopKeys.has(pairKey);
        const score = isMultiHop ? depthAdjustedScore * 1.15 : depthAdjustedScore;
        const quoteAgeMs = Date.now() - Math.min(buyQuote.timestamp, sellQuote.timestamp);

        const label = `${tokenIn}→${tokenOut} [${buyQuote.dex}↔${sellQuote.dex}]${isMultiHop ? " 🔄" : ""}`;

        results.push({
          label,
          buyQuote,
          sellQuote,
          tokenBase: tokenIn,
          tokenQuote: tokenOut,
          tradeAmountIn,
          grossProfitUsd,
          gasCostUsd,
          netProfitUsd,
          tradeAmountInUsd,
          score,
          priceImpactBuy,
          priceImpactSell,
          isMultiHop,
          quoteAgeMs,
          sizingMethod,
          invariantFamilies: Array.from(
            new Set([buyQuote.invariantFamily, sellQuote.invariantFamily])
          ),
          routeKind: selectedRoute ? "multi_hop" : "two_leg",
          multiHopRoute: selectedRoute,
        });
      }
    }

    return results;
  }
}
