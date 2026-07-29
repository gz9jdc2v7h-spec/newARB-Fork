import { ethers } from "ethers";
import {
  BALANCER_POOLS,
  CURVE_POOLS,
  DEXES,
  DexConfig,
  ENABLE_BALANCER_QUOTES,
  ENABLE_CURVE_QUOTES,
  TOKENS,
} from "../config";
import { withRetry, toFloat } from "../utils/helpers";
import {
  BALANCER_VAULT_ABI,
  CURVE_POOL_ABI,
  UNIV2_FACTORY_ABI,
  UNIV2_PAIR_ABI,
  UNIV3_QUOTER_V2_ABI,
} from "./abis";

export interface PriceQuote {
  dex: string;
  invariantFamily: "ConstantProduct" | "ConcentratedLiquidity" | "Weighted";
  quoteSource: "reserves" | "quoter";
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
  /** Optional metadata used by execution/routing paths. */
  metadata?: Record<string, string | number | boolean>;
}

// How many WETH (18 dec) we price-check by default
const DEFAULT_AMOUNT_IN_WETH = ethers.parseEther("1");
const BALANCER_POOL_TTL_MS = 5 * 60_000;
const balancerPoolTokensCache = new Map<string, { tokens: string[]; cachedAtMs: number }>();

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
    invariantFamily: "ConstantProduct",
    quoteSource: "reserves",
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
    metadata: { pair: pairAddr },
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
          invariantFamily: "ConcentratedLiquidity",
          quoteSource: "quoter",
          tokenIn: tokenInSym,
          tokenOut: tokenOutSym,
          amountIn,
          amountOut,
          price,
          gasEstimate,
          timestamp: Date.now(),
          metadata: { feeTier: fee },
        };
      }
    } catch {
      // Pool may not exist for this fee tier — skip
    }
  }

  return best;
}

async function getBalancerPoolTokens(
  provider: ethers.Provider,
  vaultAddress: string,
  poolId: string
): Promise<string[]> {
  const cached = balancerPoolTokensCache.get(poolId);
  if (cached && Date.now() - cached.cachedAtMs < BALANCER_POOL_TTL_MS) {
    return cached.tokens;
  }

  const vault = new ethers.Contract(vaultAddress, BALANCER_VAULT_ABI, provider);
  const [tokens]: [string[], bigint[], bigint] = await withRetry(() =>
    vault.getPoolTokens(poolId)
  );

  balancerPoolTokensCache.set(poolId, { tokens, cachedAtMs: Date.now() });
  return tokens;
}

async function quoteBalancer(
  provider: ethers.Provider,
  dex: DexConfig,
  tokenInSym: string,
  tokenOutSym: string,
  amountIn: bigint
): Promise<PriceQuote | null> {
  if (!ENABLE_BALANCER_QUOTES || !dex.vault) return null;

  const tokenIn = token(tokenInSym);
  const tokenOut = token(tokenOutSym);
  const vault = new ethers.Contract(dex.vault, BALANCER_VAULT_ABI, provider);
  const candidates = BALANCER_POOLS.filter(
    (pool) =>
      (pool.tokenIn === tokenInSym && pool.tokenOut === tokenOutSym) ||
      (pool.tokenIn === tokenOutSym && pool.tokenOut === tokenInSym)
  );

  let best: PriceQuote | null = null;
  for (const pool of candidates) {
    try {
      const poolTokens = await getBalancerPoolTokens(provider, dex.vault, pool.poolId);
      const inIdx = poolTokens.findIndex(
        (t) => t.toLowerCase() === tokenIn.address.toLowerCase()
      );
      const outIdx = poolTokens.findIndex(
        (t) => t.toLowerCase() === tokenOut.address.toLowerCase()
      );
      if (inIdx < 0 || outIdx < 0) continue;

      const steps = [
        {
          poolId: pool.poolId,
          assetInIndex: 0,
          assetOutIndex: 1,
          amount: amountIn,
          userData: "0x",
        },
      ];
      const assets = [tokenIn.address, tokenOut.address];
      const funds = {
        sender: ethers.ZeroAddress,
        fromInternalBalance: false,
        recipient: ethers.ZeroAddress,
        toInternalBalance: false,
      };

      const deltas: bigint[] = await withRetry(() =>
        vault.queryBatchSwap.staticCall(0, steps, assets, funds)
      );
      const outDelta = deltas[1];
      const amountOut = outDelta < 0n ? -outDelta : 0n;
      if (amountOut === 0n) continue;

      const price =
        toFloat(amountOut, tokenOut.decimals) /
        toFloat(amountIn, tokenIn.decimals);

      if (!best || amountOut > best.amountOut) {
        best = {
          dex: dex.name,
          invariantFamily: "Weighted",
          quoteSource: "quoter",
          tokenIn: tokenInSym,
          tokenOut: tokenOutSym,
          amountIn,
          amountOut,
          price,
          gasEstimate: 170_000n,
          timestamp: Date.now(),
          feeBps: pool.swapFeeBps,
          metadata: {
            poolId: pool.poolId,
            cacheHit: balancerPoolTokensCache.has(pool.poolId),
          },
        };
      }
    } catch {
      // ignore bad pool candidates and keep scanning
    }
  }

  return best;
}

async function quoteCurve(
  provider: ethers.Provider,
  tokenInSym: string,
  tokenOutSym: string,
  amountIn: bigint
): Promise<PriceQuote | null> {
  if (!ENABLE_CURVE_QUOTES) return null;

  const tokenIn = token(tokenInSym);
  const tokenOut = token(tokenOutSym);

  let best: PriceQuote | null = null;
  for (const pool of CURVE_POOLS) {
    const i = pool.tokenSymbols.findIndex((s) => s === tokenInSym);
    const j = pool.tokenSymbols.findIndex((s) => s === tokenOutSym);
    if (i < 0 || j < 0 || i === j) continue;

    const curve = new ethers.Contract(pool.pool, CURVE_POOL_ABI, provider);
    try {
      let amountOut = 0n;
      try {
        amountOut = await withRetry(() => curve.get_dy(BigInt(i), BigInt(j), amountIn));
      } catch {
        amountOut = await withRetry(() => curve.get_dy(i, j, amountIn));
      }
      if (amountOut === 0n) continue;

      const price =
        toFloat(amountOut, tokenOut.decimals) /
        toFloat(amountIn, tokenIn.decimals);
      if (!best || amountOut > best.amountOut) {
        best = {
          dex: "Curve",
          invariantFamily: "ConstantProduct",
          quoteSource: "quoter",
          tokenIn: tokenInSym,
          tokenOut: tokenOutSym,
          amountIn,
          amountOut,
          price,
          gasEstimate: 190_000n,
          timestamp: Date.now(),
          metadata: {
            pool: pool.pool,
            i,
            j,
          },
        };
      }
    } catch {
      // this pool does not support the pair/index shape
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
  if (dex.type === "Balancer") {
    return quoteBalancer(provider, dex, tokenInSym, tokenOutSym, _amountIn);
  }
  if (dex.type === "Curve") {
    return quoteCurve(provider, tokenInSym, tokenOutSym, _amountIn);
  }
  return null;
}

export function isDexEnabled(name: string): boolean {
  return DEXES.some((dex) => dex.name === name);
}
