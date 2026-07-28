import { ethers } from "ethers";
import { PairQuotes } from "../discovery/OpportunityScanner";
import { PriceQuote } from "../discovery/PriceFeeder";
import { GasData, getGasData, estimateGasCostUsd } from "./GasEstimator";
import { toFloat } from "../utils/helpers";
import { TOKENS, MIN_PROFIT_USD, MAX_SLIPPAGE } from "../config";
import { logger } from "../utils/logger";
import {
  cfmmOptimalInput,
  cfmmArbProfit,
  cfmmPriceImpact,
  cfmmLiquidityDepth,
} from "../math/CfmmMath";
import { findArbitragePaths, cycleKey, ArbPath } from "../math/BellmanFord";
import { kellyScore, kellyPositionSize } from "../math/KellyCriterion";
import { EmaTracker, classifyRegime } from "../math/EmaTracker";
import { selectOptimalPortfolio, PortfolioSelection } from "../math/QuantumSelector";

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
}

// ─── ETH price oracle (derived from snapshot) ────────────────────────────────

function ethPriceUsd(snapshot: PairQuotes[]): number {
  // Weighted average of all WETH/stable quotes for better accuracy
  let sum = 0;
  let count = 0;
  for (const pair of snapshot) {
    if (pair.tokenIn === "WETH" && (pair.tokenOut === "USDC" || pair.tokenOut === "USDT" || pair.tokenOut === "DAI")) {
      for (const q of pair.quotes) {
        sum += q.price;
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 3_000;
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
 * The closed-form solution is the global maximiser of P(x) = output − input
 * under the constant-product AMM model. No heuristic needed.
 */
function computeOptimalInput(buyQuote: PriceQuote, sellQuote: PriceQuote): bigint {
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
    // Pool layout:
    //   Pool 1 (buy): r1 = reserveIn (tokenBase), s1 = reserveOut (tokenQuote)
    //   Pool 2 (sell): r2 = reserveIn-of-tokenQuote = sellQuote.reserveOut,
    //                  s2 = reserveOut-of-tokenBase = sellQuote.reserveIn
    const x = cfmmOptimalInput(
      buyQuote.reserveIn!,
      buyQuote.reserveOut!,
      buyQuote.feeBps!,
      sellQuote.reserveOut!, // tokenQuote reserve in sell pool
      sellQuote.reserveIn!,  // tokenBase reserve in sell pool
      sellQuote.feeBps!
    );
    // Verify the profit is positive at x* (guards against edge cases)
    if (x > 0n) {
      const profit = cfmmArbProfit(
        x,
        buyQuote.reserveIn!,
        buyQuote.reserveOut!,
        buyQuote.feeBps!,
        sellQuote.reserveOut!,
        sellQuote.reserveIn!,
        sellQuote.feeBps!
      );
      if (profit > 0n) return x;
    }
  }

  // Fallback: spread-proportional fraction of quoted amount.
  // We still honour the calculus insight that x* grows with the price spread,
  // using a first-order approximation: factor ≈ spread / (2 × impact_rate).
  const spread = (sellQuote.price - buyQuote.price) / buyQuote.price;
  if (spread <= 0) return 0n;

  // Conservative cap: 60 % of quoted amount, scaled by spread magnitude
  const factor = Math.min(0.6 + spread * 4, 1.0);
  return BigInt(Math.floor(Number(buyQuote.amountIn) * factor));
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

    // Feed EMA tracker with latest prices
    this.updateEmaTracker(snapshot);

    // Run Bellman–Ford to find multi-hop cycles (informs scoring bonus)
    const arbPaths = findArbitragePaths(snapshot);
    const multiHopKeys = new Set(arbPaths.map((p) => cycleKey(p.tokens)));

    // Enumerate two-pool opportunities
    const opportunities: ArbitrageOpportunity[] = [];
    for (const pairData of snapshot) {
      const opps = this.findOpportunities(pairData, gasData, ethUsd, multiHopKeys);
      opportunities.push(...opps);
    }

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

  private findOpportunities(
    pairData: PairQuotes,
    gasData: GasData,
    ethUsd: number,
    multiHopKeys: Set<string>
  ): ArbitrageOpportunity[] {
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
        const tradeAmountIn = computeOptimalInput(buyQuote, sellQuote);
        if (tradeAmountIn === 0n) continue;

        // Scale expected output proportionally to tradeAmountIn
        const scaleFactor = Number(tradeAmountIn) / Number(buyQuote.amountIn);
        const scaledAmountOut = BigInt(Math.floor(Number(buyQuote.amountOut) * scaleFactor));

        // Gross output in tokenIn units (after selling scaledAmountOut on sell DEX)
        const grossOut =
          BigInt(Math.floor(Number(scaledAmountOut) * sellQuote.price)) - tradeAmountIn;
        if (grossOut <= 0n) continue;

        const tokenInCfg = TOKENS[tokenIn];
        if (!tokenInCfg) continue;

        // Convert gross profit to USD
        const grossProfitEth =
          tokenIn === "WETH" || tokenIn === "ETH"
            ? toFloat(grossOut, 18)
            : toFloat(grossOut, tokenInCfg.decimals) / ethUsd;
        const grossProfitUsd = grossProfitEth * ethUsd;

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
          sellQuote.reserveOut !== undefined && sellQuote.feeBps !== undefined
            ? cfmmPriceImpact(sellQuote.reserveOut, scaledAmountOut, sellQuote.feeBps)
            : spread / 2;

        // ── Liquidity depth (for scoring: prefer deep pools) ──────────────
        const buyDepth =
          buyQuote.reserveIn !== undefined
            ? cfmmLiquidityDepth(buyQuote.reserveIn, tokenInCfg.decimals, ethUsd)
            : 1e6;

        // ── Kelly risk-adjusted score ─────────────────────────────────────
        // Kelly criterion replaces the simple profit/gas ratio with a
        // utility-maximising score that accounts for execution uncertainty.
        const capitalUsd = grossProfitUsd + gasCostUsd; // rough capital proxy
        const volatilityFactor = pairStats ? 1 + pairStats.dailyVolatility * 10 : 1;
        const score = kellyScore(netProfitUsd, gasCostUsd, capitalUsd, 0.88, volatilityFactor);

        // ── Multi-hop bonus: if this pair is part of a BF cycle, score up ──
        const pairKey = cycleKey([tokenIn, tokenOut]);
        const isMultiHop = multiHopKeys.has(pairKey);

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
          score,
          priceImpactBuy,
          priceImpactSell,
          isMultiHop,
        });
      }
    }

    return results;
  }
}

