import { ethers } from "ethers";
import { DexConfig, TOKENS } from "../config";
import { withRetry, toFloat } from "../utils/helpers";
import { UNIV2_FACTORY_ABI, UNIV2_PAIR_ABI, UNIV3_QUOTER_V2_ABI } from "./abis";

export interface PriceQuote {
  dex: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  /** Effective price: amountOut / amountIn (normalised to equal decimals) */
  price: number;
  /** Gas estimate for this swap (units) */
  gasEstimate: bigint;
  timestamp: number;
  // ── UniV2 pool data (populated for CFMM-exact calculations) ──────────────
  /** Raw pool reserve of the input token (UniV2 only). */
  reserveIn?: bigint;
  /** Raw pool reserve of the output token (UniV2 only). */
  reserveOut?: bigint;
  /** Pool fee in basis points (e.g. 30 for 0.3 %). */
  feeBps?: number;
}

// How many WETH (18 dec) we price-check by default
const DEFAULT_AMOUNT_IN_WETH = ethers.parseEther("1");

/** Maps symbol → token config */
function token(symbol: string) {
  const t = TOKENS[symbol];
  if (!t) throw new Error(`Unknown token: ${symbol}`);
  return t;
}

// ─── UniV2 quote ─────────────────────────────────────────────────────────────

async function quoteUniV2(
  provider: ethers.Provider,
  dex: DexConfig,
  tokenInSym: string,
  tokenOutSym: string,
  amountIn: bigint
): Promise<PriceQuote | null> {
  const tokenIn = token(tokenInSym);
  const tokenOut = token(tokenOutSym);

  const factory = new ethers.Contract(dex.factory!, UNIV2_FACTORY_ABI, provider);
  const pairAddr: string = await withRetry(() =>
    factory.getPair(tokenIn.address, tokenOut.address)
  );
  if (pairAddr === ethers.ZeroAddress) return null;

  const pair = new ethers.Contract(pairAddr, UNIV2_PAIR_ABI, provider);
  const [t0, reserves]: [string, [bigint, bigint, number]] = await withRetry(
    () => Promise.all([pair.token0(), pair.getReserves()])
  );

  const [r0, r1] = reserves;
  const [reserveIn, reserveOut] =
    t0.toLowerCase() === tokenIn.address.toLowerCase()
      ? [r0, r1]
      : [r1, r0];

  if (reserveIn === 0n || reserveOut === 0n) return null;

  const fee = dex.defaultFee ?? 3000; // 0.3% default
  const amountInWithFee = amountIn * BigInt(1_000_000 - fee);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1_000_000n + amountInWithFee;
  const amountOut = numerator / denominator;

  const price =
    toFloat(amountOut, tokenOut.decimals) /
    toFloat(amountIn, tokenIn.decimals);

  return {
    dex: dex.name,
    tokenIn: tokenInSym,
    tokenOut: tokenOutSym,
    amountIn,
    amountOut,
    price,
    gasEstimate: 110_000n, // typical UniV2 swap gas
    timestamp: Date.now(),
    // Expose reserves so the CFMM math layer can compute the exact optimal input
    reserveIn,
    reserveOut,
    feeBps: fee / 100, // convert ppm → bps (e.g. 3000 → 30)
  };
}

// ─── UniV3 quote ─────────────────────────────────────────────────────────────

async function quoteUniV3(
  provider: ethers.Provider,
  dex: DexConfig,
  tokenInSym: string,
  tokenOutSym: string,
  amountIn: bigint
): Promise<PriceQuote | null> {
  const tokenIn = token(tokenInSym);
  const tokenOut = token(tokenOutSym);
  const quoter = new ethers.Contract(dex.quoter!, UNIV3_QUOTER_V2_ABI, provider);

  const feeTiers = dex.feeTiers ?? [3000];
  let best: PriceQuote | null = null;

  for (const fee of feeTiers) {
    try {
      const result: [bigint, bigint, number, bigint] = await withRetry(() =>
        quoter.quoteExactInputSingle.staticCall({
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        })
      );
      const [amountOut, , , gasEstimate] = result;
      if (amountOut === 0n) continue;

      const price =
        toFloat(amountOut, tokenOut.decimals) /
        toFloat(amountIn, tokenIn.decimals);

      if (!best || amountOut > best.amountOut) {
        best = {
          dex: dex.name,
          tokenIn: tokenInSym,
          tokenOut: tokenOutSym,
          amountIn,
          amountOut,
          price,
          gasEstimate,
          timestamp: Date.now(),
        };
      }
    } catch {
      // Pool may not exist for this fee tier — skip
    }
  }

  return best;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch a price quote from a single DEX.
 */
export async function fetchQuote(
  provider: ethers.Provider,
  dex: DexConfig,
  tokenInSym: string,
  tokenOutSym: string,
  amountIn?: bigint
): Promise<PriceQuote | null> {
  const tIn = token(tokenInSym);
  const _amountIn =
    amountIn ??
    (tIn.symbol === "WETH"
      ? DEFAULT_AMOUNT_IN_WETH
      : ethers.parseUnits("1000", tIn.decimals));

  if (dex.type === "UniV2") {
    return quoteUniV2(provider, dex, tokenInSym, tokenOutSym, _amountIn);
  }
  if (dex.type === "UniV3") {
    return quoteUniV3(provider, dex, tokenInSym, tokenOutSym, _amountIn);
  }
  // Balancer: skip for now (requires on-chain query for poolId)
  return null;
}
