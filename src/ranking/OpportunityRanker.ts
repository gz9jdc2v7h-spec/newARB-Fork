import { ethers } from "ethers";
import { PairQuotes } from "../discovery/OpportunityScanner";
import { PriceQuote } from "../discovery/PriceFeeder";
import { GasData, getGasData, estimateGasCostUsd } from "./GasEstimator";
import { toFloat } from "../utils/helpers";
import { TOKENS, MIN_PROFIT_USD, MAX_SLIPPAGE } from "../config";
import { logger } from "../utils/logger";

export interface ArbitrageOpportunity {
  /** Human-readable description */
  label: string;
  /** Buy on this DEX (lower price) */
  buyQuote: PriceQuote;
  /** Sell on this DEX (higher price) */
  sellQuote: PriceQuote;
  tokenBase: string;
  tokenQuote: string;
  /** Optimal trade size in tokenBase units (raw) */
  tradeAmountIn: bigint;
  /** Expected gross profit in USD */
  grossProfitUsd: number;
  /** Estimated gas cost in USD */
  gasCostUsd: number;
  /** Expected net profit in USD */
  netProfitUsd: number;
  /** Profit-to-gas ratio (higher = better) */
  score: number;
}

/**
 * Derive ETH price in USD from WETH/USDC or WETH/USDT quotes.
 */
function ethPriceUsd(snapshot: PairQuotes[]): number {
  for (const pair of snapshot) {
    if (pair.tokenIn === "WETH" && (pair.tokenOut === "USDC" || pair.tokenOut === "USDT")) {
      const prices = pair.quotes.map((q) => q.price);
      if (prices.length > 0) {
        return prices.reduce((a, b) => a + b, 0) / prices.length;
      }
    }
  }
  return 3_000; // fallback
}

/**
 * Optimal trade size for a two-pool arbitrage (CFMM approximation).
 *
 * Given two UniV2-style pools with the same token pair and constant-product
 * AMM, the optimal input is √(r1_in * r2_in) – adjusted for fees.
 * For simplicity we use the quoted amountIn scaled by the price spread.
 */
function optimalTradeSize(buyQuote: PriceQuote, sellQuote: PriceQuote): bigint {
  // Use the amount the quoter already priced as the baseline.
  // A real optimiser would solve d(profit)/d(x)=0; here we approximate
  // by scaling to a fraction of the priced amount proportional to spread.
  const spread = (sellQuote.price - buyQuote.price) / buyQuote.price;
  // Cap at 50 % of the quoted input; trade larger at higher spreads.
  const factor = Math.min(0.5 + spread * 5, 1.0);
  return BigInt(Math.floor(Number(buyQuote.amountIn) * factor));
}

export class OpportunityRanker {
  private provider: ethers.Provider;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
  }

  async rank(snapshot: PairQuotes[]): Promise<ArbitrageOpportunity[]> {
    const gasData = await getGasData(this.provider);
    const ethUsd = ethPriceUsd(snapshot);
    const opportunities: ArbitrageOpportunity[] = [];

    for (const pairData of snapshot) {
      const opps = this.findOpportunities(pairData, gasData, ethUsd);
      opportunities.push(...opps);
    }

    // Sort descending by net profit score
    opportunities.sort((a, b) => b.score - a.score);

    if (opportunities.length > 0) {
      logger.info(`Ranked ${opportunities.length} opportunity/ies`, {
        best: opportunities[0]!.label,
        netProfitUsd: opportunities[0]!.netProfitUsd.toFixed(2),
      });
    }

    return opportunities;
  }

  private findOpportunities(
    pairData: PairQuotes,
    gasData: GasData,
    ethUsd: number
  ): ArbitrageOpportunity[] {
    const { tokenIn, tokenOut, quotes } = pairData;
    if (quotes.length < 2) return [];

    const results: ArbitrageOpportunity[] = [];

    // Compare every pair of quotes for the same (tokenIn, tokenOut)
    for (let i = 0; i < quotes.length; i++) {
      for (let j = i + 1; j < quotes.length; j++) {
        const a = quotes[i]!;
        const b = quotes[j]!;

        // Identify buy (lower price) and sell (higher price) sides
        const [buyQuote, sellQuote] =
          a.price < b.price ? [a, b] : [b, a];

        const spread = (sellQuote.price - buyQuote.price) / buyQuote.price;

        // Filter out negligible spreads (less than slippage × 2)
        if (spread < MAX_SLIPPAGE * 2) continue;

        const tradeAmountIn = optimalTradeSize(buyQuote, sellQuote);
        if (tradeAmountIn === 0n) continue;

        // Scale amountOut proportionally to tradeAmountIn
        const scaleFactor =
          Number(tradeAmountIn) / Number(buyQuote.amountIn);
        const scaledAmountOut = BigInt(
          Math.floor(Number(buyQuote.amountOut) * scaleFactor)
        );

        // Gross profit in tokenOut units
        const grossOut =
          BigInt(Math.floor(Number(scaledAmountOut) * sellQuote.price)) -
          tradeAmountIn;

        if (grossOut <= 0n) continue;

        const tokenInCfg = TOKENS[tokenIn];
        if (!tokenInCfg) continue;

        const grossProfitEth =
          tokenIn === "WETH" || tokenIn === "ETH"
            ? toFloat(grossOut, 18)
            : toFloat(grossOut, tokenInCfg.decimals) / ethUsd;

        const grossProfitUsd = grossProfitEth * ethUsd;

        // Gas: buy swap + sell swap
        const totalGasUnits = buyQuote.gasEstimate + sellQuote.gasEstimate;
        const gasCostUsd = estimateGasCostUsd(totalGasUnits, gasData, ethUsd);

        const netProfitUsd = grossProfitUsd - gasCostUsd;

        if (netProfitUsd < MIN_PROFIT_USD) continue;

        const score = netProfitUsd / (gasCostUsd || 1);

        const label = `${tokenIn}→${tokenOut} [${buyQuote.dex}↔${sellQuote.dex}]`;

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
        });
      }
    }

    return results;
  }
}
