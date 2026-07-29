import { ethers } from "ethers";
import { ArbitrageOpportunity } from "../ranking/OpportunityRanker";
import { getGasData } from "../ranking/GasEstimator";
import { withRetry, deadline, toFloat } from "../utils/helpers";
import { logger } from "../utils/logger";
import { TOKENS, getWallet, MAX_SLIPPAGE, DEXES } from "../config";
import {
  BALANCER_VAULT_ABI,
  UNIV2_ROUTER_ABI,
  UNIV3_ROUTER_ABI,
  ERC20_ABI,
} from "../discovery/abis";

// ─── ERC-20 approval helper ───────────────────────────────────────────────────

async function ensureApproval(
  wallet: ethers.Wallet,
  tokenAddress: string,
  spender: string,
  amount: bigint
): Promise<void> {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const allowance: bigint = await token.allowance(wallet.address, spender);
  if (allowance >= amount) return;

  logger.info("Approving token", { token: tokenAddress, spender });
  const tx = await token.approve(spender, ethers.MaxUint256);
  await tx.wait(1);
  logger.info("Approval confirmed");
}

// ─── Swap execution helpers ───────────────────────────────────────────────────

async function executeUniV2Swap(
  wallet: ethers.Wallet,
  routerAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOutMin: bigint,
  gasData: Awaited<ReturnType<typeof getGasData>>
): Promise<ethers.TransactionReceipt> {
  const router = new ethers.Contract(routerAddress, UNIV2_ROUTER_ABI, wallet);
  await ensureApproval(wallet, tokenIn, routerAddress, amountIn);

  const tx: ethers.TransactionResponse = await router.swapExactTokensForTokens(
    amountIn,
    amountOutMin,
    [tokenIn, tokenOut],
    wallet.address,
    deadline(),
    {
      maxFeePerGas: gasData.maxFeePerGas,
      maxPriorityFeePerGas: gasData.maxPriorityFee,
    }
  );

  logger.info("UniV2 swap submitted", { hash: tx.hash });
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt for UniV2 swap");
  return receipt;
}

async function executeUniV3Swap(
  wallet: ethers.Wallet,
  routerAddress: string,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: bigint,
  amountOutMin: bigint,
  gasData: Awaited<ReturnType<typeof getGasData>>
): Promise<ethers.TransactionReceipt> {
  const router = new ethers.Contract(routerAddress, UNIV3_ROUTER_ABI, wallet);
  await ensureApproval(wallet, tokenIn, routerAddress, amountIn);

  const tx: ethers.TransactionResponse = await router.exactInputSingle(
    {
      tokenIn,
      tokenOut,
      fee,
      recipient: wallet.address,
      amountIn,
      amountOutMinimum: amountOutMin,
      sqrtPriceLimitX96: 0n,
    },
    {
      maxFeePerGas: gasData.maxFeePerGas,
      maxPriorityFeePerGas: gasData.maxPriorityFee,
    }
  );

  logger.info("UniV3 swap submitted", { hash: tx.hash });
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt for UniV3 swap");
  return receipt;
}

async function executeBalancerSwap(
  wallet: ethers.Wallet,
  vaultAddress: string,
  poolId: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  amountOutMin: bigint,
  gasData: Awaited<ReturnType<typeof getGasData>>
): Promise<ethers.TransactionReceipt> {
  const vault = new ethers.Contract(vaultAddress, BALANCER_VAULT_ABI, wallet);
  await ensureApproval(wallet, tokenIn, vaultAddress, amountIn);

  const tx: ethers.TransactionResponse = await vault.swap(
    {
      poolId,
      kind: 0, // GIVEN_IN
      assetIn: tokenIn,
      assetOut: tokenOut,
      amount: amountIn,
      userData: "0x",
    },
    {
      sender: wallet.address,
      fromInternalBalance: false,
      recipient: wallet.address,
      toInternalBalance: false,
    },
    amountOutMin,
    deadline(),
    {
      maxFeePerGas: gasData.maxFeePerGas,
      maxPriorityFeePerGas: gasData.maxPriorityFee,
    }
  );

  logger.info("Balancer swap submitted", { hash: tx.hash, poolId });
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt for Balancer swap");
  return receipt;
}

// ─── Circuit breaker ─────────────────────────────────────────────────────────

interface CircuitBreaker {
  failures: number;
  lastFailureTs: number;
  open: boolean;
}

const circuitBreaker: CircuitBreaker = {
  failures: 0,
  lastFailureTs: 0,
  open: false,
};

const CB_THRESHOLD = 3;         // consecutive failures to open
const CB_RESET_MS = 30_000;     // 30 s cool-down

function checkCircuitBreaker(): boolean {
  if (!circuitBreaker.open) return true;
  if (Date.now() - circuitBreaker.lastFailureTs > CB_RESET_MS) {
    logger.info("Circuit breaker half-open — retrying");
    circuitBreaker.open = false;
    circuitBreaker.failures = 0;
    return true;
  }
  return false;
}

function recordSuccess(): void {
  circuitBreaker.failures = 0;
  circuitBreaker.open = false;
}

function recordFailure(): void {
  circuitBreaker.failures++;
  circuitBreaker.lastFailureTs = Date.now();
  if (circuitBreaker.failures >= CB_THRESHOLD) {
    logger.warn("Circuit breaker OPEN — pausing execution", {
      failures: circuitBreaker.failures,
    });
    circuitBreaker.open = true;
  }
}

// ─── Main Executor ────────────────────────────────────────────────────────────

export class Executor {
  private provider: ethers.Provider;
  private wallet: ethers.Wallet;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
    this.wallet = getWallet(provider);
  }

  /**
   * Executes the best opportunity from a ranked list.
   * Uses a two-leg sequential swap: buy on cheaper DEX, sell on pricier DEX.
   */
  async execute(opportunity: ArbitrageOpportunity): Promise<boolean> {
    if (!checkCircuitBreaker()) {
      logger.warn("Circuit breaker is OPEN — skipping execution");
      return false;
    }

    const { buyQuote, sellQuote, tradeAmountIn, label } = opportunity;
    logger.info("Executing opportunity", {
      label,
      netProfitUsd: opportunity.netProfitUsd.toFixed(2),
    });

    try {
      const gasData = await getGasData(this.provider);

      const tokenInCfg = TOKENS[buyQuote.tokenIn]!;
      const tokenOutCfg = TOKENS[buyQuote.tokenOut]!;

      // ── Leg 1: sell tokenIn on the higher-price DEX (sellQuote) ────────────
      // Selling where tokenIn is worth MORE maximises the tokenOut received.
      const slippageFactor = 1 - MAX_SLIPPAGE;
      const minOut1 = BigInt(
        Math.floor(Number(sellQuote.amountOut) * slippageFactor)
      );

      const sellDexCfg = DEXES.find((d) => d.name === sellQuote.dex)!;
      let receipt1: ethers.TransactionReceipt;

      if (sellDexCfg.type === "UniV2") {
        receipt1 = await withRetry(() =>
          executeUniV2Swap(
            this.wallet,
            sellDexCfg.router,
            tokenInCfg.address,
            tokenOutCfg.address,
            tradeAmountIn,
            minOut1,
            gasData
          )
        );
      } else if (sellDexCfg.type === "UniV3") {
        const fee = sellQuote.poolFee ?? sellDexCfg.feeTiers?.[0] ?? 3000;
        receipt1 = await withRetry(() =>
          executeUniV3Swap(
            this.wallet,
            sellDexCfg.router,
            tokenInCfg.address,
            tokenOutCfg.address,
            fee,
            tradeAmountIn,
            minOut1,
            gasData
          )
        );
      } else {
        if (!sellQuote.poolId || !sellDexCfg.vault) {
          throw new Error(
            `Missing Balancer ${!sellQuote.poolId ? "poolId" : "vault address"} for ${sellQuote.dex}`
          );
        }
        const sellVault = sellDexCfg.vault;
        const sellPoolId = sellQuote.poolId;
        receipt1 = await withRetry(() =>
          executeBalancerSwap(
            this.wallet,
            sellVault,
            sellPoolId,
            tokenInCfg.address,
            tokenOutCfg.address,
            tradeAmountIn,
            minOut1,
            gasData
          )
        );
      }

      logger.info("Leg 1 confirmed", { hash: receipt1.hash, gas: receipt1.gasUsed.toString() });

      // ── Leg 2: buy tokenIn back on the lower-price DEX (buyQuote) ──────────
      // Buying back where tokenIn costs LESS maximises the round-trip profit.
      // Use the actual output from leg 1 as input to leg 2.
      const actualOut1 = await this.getActualOutput(receipt1, tokenOutCfg.address);
      if (actualOut1 === 0n) {
        throw new Error("Leg 1 produced no output — aborting before leg 2");
      }
      const minOut2 = BigInt(Math.floor(Number(actualOut1) * slippageFactor));

      const buyDexCfg = DEXES.find((d) => d.name === buyQuote.dex)!;
      let receipt2: ethers.TransactionReceipt;

      if (buyDexCfg.type === "UniV2") {
        receipt2 = await withRetry(() =>
          executeUniV2Swap(
            this.wallet,
            buyDexCfg.router,
            tokenOutCfg.address,
            tokenInCfg.address,
            actualOut1,
            minOut2,
            gasData
          )
        );
      } else if (buyDexCfg.type === "UniV3") {
        const fee = buyQuote.poolFee ?? buyDexCfg.feeTiers?.[0] ?? 3000;
        receipt2 = await withRetry(() =>
          executeUniV3Swap(
            this.wallet,
            buyDexCfg.router,
            tokenOutCfg.address,
            tokenInCfg.address,
            fee,
            actualOut1,
            minOut2,
            gasData
          )
        );
      } else {
        if (!buyQuote.poolId || !buyDexCfg.vault) {
          throw new Error(
            `Missing Balancer ${!buyQuote.poolId ? "poolId" : "vault address"} for ${buyQuote.dex}`
          );
        }
        const buyVault = buyDexCfg.vault;
        const buyPoolId = buyQuote.poolId;
        receipt2 = await withRetry(() =>
          executeBalancerSwap(
            this.wallet,
            buyVault,
            buyPoolId,
            tokenOutCfg.address,
            tokenInCfg.address,
            actualOut1,
            minOut2,
            gasData
          )
        );
      }

      logger.info("Leg 2 confirmed", { hash: receipt2.hash, gas: receipt2.gasUsed.toString() });

      recordSuccess();
      return true;
    } catch (err) {
      logger.error("Execution failed", { label, err: String(err) });
      recordFailure();
      return false;
    }
  }

  /**
   * Reads the actual token output from a receipt by parsing Transfer events.
   */
  private async getActualOutput(
    receipt: ethers.TransactionReceipt,
    tokenAddress: string
  ): Promise<bigint> {
    const transferTopic = ethers.id("Transfer(address,address,uint256)");
    let totalOut = 0n;
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === tokenAddress.toLowerCase() &&
        log.topics[0] === transferTopic &&
        log.topics[2]?.toLowerCase() ===
          ethers.zeroPadValue(this.wallet.address.toLowerCase(), 32).toLowerCase()
      ) {
        totalOut += ethers.AbiCoder.defaultAbiCoder().decode(
          ["uint256"],
          log.data
        )[0] as bigint;
      }
    }
    return totalOut;
  }
}
