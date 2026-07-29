import { ethers } from "ethers";
import { DexConfig, TOKENS } from "../config";
import { pLimit, positiveIntEnv, withRetry, toFloat } from "../utils/helpers";
import {
  BALANCER_VAULT_ABI,
  UNIV2_FACTORY_ABI,
  UNIV2_PAIR_ABI,
  UNIV3_QUOTER_V2_ABI,
} from "./abis";

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
  /** UniV3 fee tier used by the quote (e.g. 500/3000/10000). */
  poolFee?: number;
  /** Balancer pool id used by the quote. */
  poolId?: string;
}

// How many WETH (18 dec) we price-check by default
const DEFAULT_AMOUNT_IN_WETH = ethers.parseEther("1");
const BALANCER_POOL_REGISTERED_TOPIC = ethers.id(
  "PoolRegistered(bytes32,address,uint8)"
);
const BALANCER_SWAP_GAS_ESTIMATE = 170_000n;

const BALANCER_DISCOVERY_FROM_BLOCK = positiveIntEnv(
  "BALANCER_DISCOVERY_FROM_BLOCK",
  1
);
const BALANCER_DISCOVERY_STEP = positiveIntEnv(
  "BALANCER_DISCOVERY_STEP",
  200000
);
const BALANCER_DISCOVERY_CONCURRENCY = positiveIntEnv(
  "BALANCER_DISCOVERY_CONCURRENCY",
  16
);

const balancerPairPoolCache = new Map<string, Promise<string[]>>();
const balancerPoolTokensCache = new Map<string, Promise<string[]>>();

/** Maps symbol → token config */
function token(symbol: string) {
  const t = TOKENS[symbol];
  if (!t) throw new Error(`Unknown token: ${symbol}`);
  return t;
}

function canonicalPairKey(tokenA: string, tokenB: string): string {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function balancerPairCacheKey(vault: string, tokenA: string, tokenB: string): string {
  return `${vault.toLowerCase()}:${canonicalPairKey(tokenA, tokenB)}`;
}

async function getBalancerPoolTokens(
  provider: ethers.Provider,
  vault: string,
  poolId: string
): Promise<string[]> {
  const cacheKey = `${vault.toLowerCase()}:${poolId.toLowerCase()}`;
  const cached = balancerPoolTokensCache.get(cacheKey);
  if (cached) return cached;

  const task = (async () => {
    const vaultContract = new ethers.Contract(vault, BALANCER_VAULT_ABI, provider);
    const [tokens]: [string[], bigint[], bigint] = await withRetry(() =>
      vaultContract.getPoolTokens(poolId)
    );
    return tokens.map((t) => t.toLowerCase());
  })();

  balancerPoolTokensCache.set(cacheKey, task);
  return task;
}

async function discoverBalancerPoolsForPair(
  provider: ethers.Provider,
  vault: string,
  tokenInAddress: string,
  tokenOutAddress: string
): Promise<string[]> {
  const cacheKey = balancerPairCacheKey(vault, tokenInAddress, tokenOutAddress);
  const cached = balancerPairPoolCache.get(cacheKey);
  if (cached) return cached;

  const task = (async () => {
    const latestBlock = await provider.getBlockNumber();
    const poolIds = new Set<string>();

    for (
      let fromBlock = BALANCER_DISCOVERY_FROM_BLOCK;
      fromBlock <= latestBlock;
      fromBlock += BALANCER_DISCOVERY_STEP
    ) {
      const toBlock = Math.min(fromBlock + BALANCER_DISCOVERY_STEP - 1, latestBlock);
      const logs = await withRetry(() =>
        provider.getLogs({
          address: vault,
          fromBlock,
          toBlock,
          topics: [BALANCER_POOL_REGISTERED_TOPIC],
        })
      );
      for (const log of logs) {
        const poolId = log.topics[1];
        if (poolId) poolIds.add(poolId);
      }
    }

    if (poolIds.size === 0) return [];

    const tokenA = tokenInAddress.toLowerCase();
    const tokenB = tokenOutAddress.toLowerCase();
    const poolIdList = Array.from(poolIds);
    const matches = await pLimit(
      poolIdList.map(
        (poolId) =>
          async (): Promise<string | null> => {
            try {
              const tokens = await getBalancerPoolTokens(provider, vault, poolId);
              return tokens.includes(tokenA) && tokens.includes(tokenB) ? poolId : null;
            } catch {
              return null;
            }
          }
      ),
      BALANCER_DISCOVERY_CONCURRENCY
    );

    return matches.filter((poolId): poolId is string => poolId !== null);
  })();

  balancerPairPoolCache.set(cacheKey, task);
  return task;
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
          poolFee: fee,
        };
      }
    } catch {
      // Pool may not exist for this fee tier — skip
    }
  }

  return best;
}

// ─── Balancer quote ───────────────────────────────────────────────────────────

async function quoteBalancer(
  provider: ethers.Provider,
  dex: DexConfig,
  tokenInSym: string,
  tokenOutSym: string,
  amountIn: bigint
): Promise<PriceQuote | null> {
  if (!dex.vault) return null;

  const tokenIn = token(tokenInSym);
  const tokenOut = token(tokenOutSym);
  const vault = new ethers.Contract(dex.vault, BALANCER_VAULT_ABI, provider);
  const candidatePools = await discoverBalancerPoolsForPair(
    provider,
    dex.vault,
    tokenIn.address,
    tokenOut.address
  );
  if (candidatePools.length === 0) return null;

  let best: PriceQuote | null = null;

  for (const poolId of candidatePools) {
    try {
      const deltas: bigint[] = await withRetry(() =>
        vault.queryBatchSwap.staticCall(
          0, // GIVEN_IN
          [
            {
              poolId,
              assetInIndex: 0n,
              assetOutIndex: 1n,
              amount: amountIn,
              userData: "0x",
            },
          ],
          [tokenIn.address, tokenOut.address],
          {
            sender: ethers.ZeroAddress,
            fromInternalBalance: false,
            recipient: ethers.ZeroAddress,
            toInternalBalance: false,
          }
        )
      );

      if (deltas.length < 2) continue;
      const amountOut = -deltas[1];
      if (amountOut <= 0n) continue;

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
          gasEstimate: BALANCER_SWAP_GAS_ESTIMATE,
          timestamp: Date.now(),
          poolId,
        };
      }
    } catch {
      // Pool may reject this path/amount — skip
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
  return quoteBalancer(provider, dex, tokenInSym, tokenOutSym, _amountIn);
}
