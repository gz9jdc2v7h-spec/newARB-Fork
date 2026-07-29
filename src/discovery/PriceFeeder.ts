import { ethers } from "ethers";
import { DexConfig, TOKENS } from "../config";
import { withRetry, toFloat } from "../utils/helpers";
import { UNIV2_FACTORY_ABI, UNIV2_PAIR_ABI, UNIV3_QUOTER_V2_ABI, BALANCER_VAULT_ABI } from "./abis";
import { logger } from "../utils/logger";

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
        };
      }
    } catch {
      // Pool may not exist for this fee tier — skip
    }
  }

  return best;
}

// ─── Balancer V2 quote ────────────────────────────────────────────────────────

/**
 * Queries the Balancer V2 Vault for a GIVEN_IN swap quote across all
 * configured pools that contain both tokenIn and tokenOut.
 *
 * Uses queryBatchSwap via staticCall so no transaction is sent.
 * Returns the best (highest amountOut) quote found across eligible pools.
 */
async function quoteBalancer(
  provider: ethers.Provider,
  dex: DexConfig,
  tokenInSym: string,
  tokenOutSym: string,
  amountIn: bigint
): Promise<PriceQuote | null> {
  if (!dex.vault || !dex.pools || dex.pools.length === 0) return null;

  const tokenIn = token(tokenInSym);
  const tokenOut = token(tokenOutSym);
  const vault = new ethers.Contract(dex.vault, BALANCER_VAULT_ABI, provider);

  // Only consider pools that are declared to contain both tokens
  const eligiblePools = dex.pools.filter(
    (p) => p.tokens.includes(tokenInSym) && p.tokens.includes(tokenOutSym)
  );
  if (eligiblePools.length === 0) return null;

  let best: PriceQuote | null = null;

  for (const pool of eligiblePools) {
    try {
      // Fetch the canonical token ordering from the vault (authoritative sort)
      const [poolTokens]: [string[], bigint[], number] = await withRetry(() =>
        vault.getPoolTokens(pool.poolId)
      );

      const tokenInIdx = poolTokens.findIndex(
        (t) => t.toLowerCase() === tokenIn.address.toLowerCase()
      );
      const tokenOutIdx = poolTokens.findIndex(
        (t) => t.toLowerCase() === tokenOut.address.toLowerCase()
      );
      if (tokenInIdx === -1 || tokenOutIdx === -1) continue;

      // GIVEN_IN = 0: we specify amountIn and ask how much comes out
      const swaps = [
        {
          poolId: pool.poolId,
          assetInIndex: tokenInIdx,
          assetOutIndex: tokenOutIdx,
          amount: amountIn,
          userData: "0x",
        },
      ];
      const funds = {
        sender: ethers.ZeroAddress,
        fromInternalBalance: false,
        recipient: ethers.ZeroAddress,
        toInternalBalance: false,
      };

      // queryBatchSwap is nonpayable but safe to staticCall for simulation
      const deltas: bigint[] = await withRetry(() =>
        vault.queryBatchSwap.staticCall(0, swaps, poolTokens, funds)
      );

      // Positive delta = vault receives, negative delta = vault pays out
      const delta = deltas[tokenOutIdx];
      if (delta === undefined || delta >= 0n) continue;
      const amountOut = -delta;
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
          gasEstimate: 130_000n, // typical Balancer single-hop swap gas
          timestamp: Date.now(),
        };
      }
    } catch (err) {
      logger.debug("Balancer quote failed", { pool: pool.poolId, err: String(err) });
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
  return null;
}
