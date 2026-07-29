import { ethers } from "ethers";
import { ArbitrageOpportunity } from "../ranking/OpportunityRanker";
import { getGasData } from "../ranking/GasEstimator";
import { withRetry, deadline } from "../utils/helpers";
import { logger } from "../utils/logger";
import {
  DEXES,
  ENABLE_MEMPOOL_REPRICING,
  ENABLE_MULTI_HOP_EXECUTION,
  MAX_SLIPPAGE,
  TOKENS,
} from "../config";
import {
  BALANCER_VAULT_ABI,
  CURVE_POOL_ABI,
  ERC20_ABI,
  UNIV2_ROUTER_ABI,
  UNIV3_ROUTER_ABI,
} from "../discovery/abis";
import { RuntimeEventStream } from "../runtime/RuntimeEventStream";
import { MempoolRepricingManager } from "../runtime/MempoolRepricingManager";

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
      kind: 0,
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

  logger.info("Balancer swap submitted", { hash: tx.hash });
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt for Balancer swap");
  return receipt;
}

async function executeCurveSwap(
  wallet: ethers.Wallet,
  poolAddress: string,
  i: number,
  j: number,
  tokenIn: string,
  amountIn: bigint,
  amountOutMin: bigint,
  gasData: Awaited<ReturnType<typeof getGasData>>
): Promise<ethers.TransactionReceipt> {
  const pool = new ethers.Contract(poolAddress, CURVE_POOL_ABI, wallet);
  await ensureApproval(wallet, tokenIn, poolAddress, amountIn);

  let tx: ethers.TransactionResponse;
  try {
    tx = await pool.exchange(BigInt(i), BigInt(j), amountIn, amountOutMin, {
      maxFeePerGas: gasData.maxFeePerGas,
      maxPriorityFeePerGas: gasData.maxPriorityFee,
    });
  } catch {
    tx = await pool.exchange(i, j, amountIn, amountOutMin, {
      maxFeePerGas: gasData.maxFeePerGas,
      maxPriorityFeePerGas: gasData.maxPriorityFee,
    });
  }

  logger.info("Curve swap submitted", { hash: tx.hash });
  const receipt = await tx.wait(1);
  if (!receipt) throw new Error("No receipt for Curve swap");
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

const CB_THRESHOLD = 3; // consecutive failures to open
const CB_RESET_MS = 30_000; // 30 s cool-down

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
  private readonly eventStream?: RuntimeEventStream;
  private readonly repricer?: MempoolRepricingManager;

  constructor(provider: ethers.Provider, eventStream?: RuntimeEventStream) {
    this.provider = provider;
    this.wallet = new ethers.Wallet(process.env["PRIVATE_KEY"] ?? "", provider);
    this.eventStream = eventStream;
    this.repricer = ENABLE_MEMPOOL_REPRICING
      ? new MempoolRepricingManager(eventStream)
      : undefined;
  }

  /**
   * Executes the best opportunity from a ranked list.
   * Uses a two-leg sequential swap by default and a concrete step-based path
   * when multi-hop execution is enabled and available.
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
      routeKind: opportunity.routeKind,
    });

    try {
      const gasData = await getGasData(this.provider);

      if (
        ENABLE_MULTI_HOP_EXECUTION &&
        opportunity.routeKind === "multi_hop" &&
        opportunity.multiHopRoute?.valid
      ) {
        return this.executeMultiHop(opportunity, gasData);
      }

      const tokenInCfg = TOKENS[buyQuote.tokenIn]!;
      const tokenOutCfg = TOKENS[buyQuote.tokenOut]!;

      // ── Leg 1: sell tokenIn on the higher-price DEX (sellQuote) ────────────
      const slippageFactor = 1 - MAX_SLIPPAGE;
      const minOut1 = BigInt(Math.floor(Number(sellQuote.amountOut) * slippageFactor));

      const sellDexCfg = DEXES.find((d) => d.name === sellQuote.dex)!;
      let receipt1: ethers.TransactionReceipt;

      if (sellDexCfg.type === "UniV2" && sellDexCfg.router) {
        receipt1 = await withRetry(() =>
          executeUniV2Swap(
            this.wallet,
            sellDexCfg.router!,
            tokenInCfg.address,
            tokenOutCfg.address,
            tradeAmountIn,
            minOut1,
            gasData
          )
        );
      } else if (sellDexCfg.type === "UniV3" && sellDexCfg.router) {
        const fee = Number(sellQuote.metadata?.feeTier ?? sellDexCfg.feeTiers?.[0] ?? 3000);
        receipt1 = await withRetry(() =>
          executeUniV3Swap(
            this.wallet,
            sellDexCfg.router!,
            tokenInCfg.address,
            tokenOutCfg.address,
            fee,
            tradeAmountIn,
            minOut1,
            gasData
          )
        );
      } else if (sellDexCfg.type === "Balancer" && sellDexCfg.vault) {
        const poolId = String(sellQuote.metadata?.poolId ?? "");
        if (!poolId) throw new Error("Missing Balancer poolId metadata for sell leg");
        receipt1 = await withRetry(() =>
          executeBalancerSwap(
            this.wallet,
            sellDexCfg.vault!,
            poolId,
            tokenInCfg.address,
            tokenOutCfg.address,
            tradeAmountIn,
            minOut1,
            gasData
          )
        );
      } else if (sellDexCfg.type === "Curve") {
        const pool = String(sellQuote.metadata?.pool ?? "");
        const i = Number(sellQuote.metadata?.i ?? -1);
        const j = Number(sellQuote.metadata?.j ?? -1);
        if (!pool || i < 0 || j < 0) {
          throw new Error("Missing Curve pool metadata for sell leg");
        }
        receipt1 = await withRetry(() =>
          executeCurveSwap(
            this.wallet,
            pool,
            i,
            j,
            tokenInCfg.address,
            tradeAmountIn,
            minOut1,
            gasData
          )
        );
      } else {
        throw new Error(`Unsupported sell DEX type: ${sellDexCfg.type}`);
      }

      this.repricer?.registerSubmission(label, receipt1.hash);
      this.eventStream?.publishExecutionStatus({
        source: "executor",
        opportunityId: label,
        mode: "sequential_live",
        status: "submitted",
        detail: receipt1.hash,
      });

      logger.info("Leg 1 confirmed", { hash: receipt1.hash, gas: receipt1.gasUsed.toString() });
      this.publishReceipt(receipt1);

      const actualOut1 = await this.getActualOutput(receipt1, tokenOutCfg.address);
      if (actualOut1 === 0n) {
        throw new Error("Leg 1 produced no output — aborting before leg 2");
      }
      const minOut2 = BigInt(Math.floor(Number(actualOut1) * slippageFactor));

      const buyDexCfg = DEXES.find((d) => d.name === buyQuote.dex)!;
      let receipt2: ethers.TransactionReceipt;

      if (buyDexCfg.type === "UniV2" && buyDexCfg.router) {
        receipt2 = await withRetry(() =>
          executeUniV2Swap(
            this.wallet,
            buyDexCfg.router!,
            tokenOutCfg.address,
            tokenInCfg.address,
            actualOut1,
            minOut2,
            gasData
          )
        );
      } else if (buyDexCfg.type === "UniV3" && buyDexCfg.router) {
        const fee = Number(buyQuote.metadata?.feeTier ?? buyDexCfg.feeTiers?.[0] ?? 3000);
        receipt2 = await withRetry(() =>
          executeUniV3Swap(
            this.wallet,
            buyDexCfg.router!,
            tokenOutCfg.address,
            tokenInCfg.address,
            fee,
            actualOut1,
            minOut2,
            gasData
          )
        );
      } else if (buyDexCfg.type === "Balancer" && buyDexCfg.vault) {
        const poolId = String(buyQuote.metadata?.poolId ?? "");
        if (!poolId) throw new Error("Missing Balancer poolId metadata for buy leg");
        receipt2 = await withRetry(() =>
          executeBalancerSwap(
            this.wallet,
            buyDexCfg.vault!,
            poolId,
            tokenOutCfg.address,
            tokenInCfg.address,
            actualOut1,
            minOut2,
            gasData
          )
        );
      } else if (buyDexCfg.type === "Curve") {
        const pool = String(buyQuote.metadata?.pool ?? "");
        const i = Number(buyQuote.metadata?.j ?? -1);
        const j = Number(buyQuote.metadata?.i ?? -1);
        if (!pool || i < 0 || j < 0) {
          throw new Error("Missing Curve pool metadata for buy leg");
        }
        receipt2 = await withRetry(() =>
          executeCurveSwap(
            this.wallet,
            pool,
            i,
            j,
            tokenOutCfg.address,
            actualOut1,
            minOut2,
            gasData
          )
        );
      } else {
        throw new Error(`Unsupported buy DEX type: ${buyDexCfg.type}`);
      }

      logger.info("Leg 2 confirmed", { hash: receipt2.hash, gas: receipt2.gasUsed.toString() });
      this.publishReceipt(receipt2);
      this.repricer?.markConfirmed(label, receipt2.hash);
      this.eventStream?.publishExecutionStatus({
        source: "executor",
        opportunityId: label,
        mode: "sequential_live",
        status: "confirmed",
        detail: receipt2.hash,
      });

      recordSuccess();
      return true;
    } catch (err) {
      logger.error("Execution failed", { label, err: String(err) });
      this.repricer?.markReverted(label, String(err));
      this.eventStream?.publishExecutionStatus({
        source: "executor",
        opportunityId: label,
        mode: "sequential_live",
        status: "reverted",
        detail: String(err),
      });
      recordFailure();
      return false;
    }
  }

  private async executeMultiHop(
    opportunity: ArbitrageOpportunity,
    gasData: Awaited<ReturnType<typeof getGasData>>
  ): Promise<boolean> {
    const route = opportunity.multiHopRoute;
    if (!route?.valid) return false;

    this.eventStream?.publishExecutionStatus({
      source: "executor",
      opportunityId: opportunity.label,
      mode: "multi_hop",
      status: "submitted",
      detail: route.routeId,
    });

    for (const step of route.steps) {
      const dex = DEXES.find((d) => d.name === step.dex);
      const tokenInCfg = TOKENS[step.tokenIn];
      const tokenOutCfg = TOKENS[step.tokenOut];
      if (!dex || !tokenInCfg || !tokenOutCfg || !dex.router) {
        throw new Error(`Unsupported multi-hop step ${step.dex} ${step.tokenIn}/${step.tokenOut}`);
      }

      const amountIn = BigInt(step.amountIn);
      const minOut = BigInt(
        Math.floor(Number(step.expectedOut) * Math.max(0, 1 - MAX_SLIPPAGE))
      );

      const receipt =
        dex.type === "UniV2"
          ? await executeUniV2Swap(
              this.wallet,
              dex.router,
              tokenInCfg.address,
              tokenOutCfg.address,
              amountIn,
              minOut,
              gasData
            )
          : await executeUniV3Swap(
              this.wallet,
              dex.router,
              tokenInCfg.address,
              tokenOutCfg.address,
              dex.feeTiers?.[0] ?? 3000,
              amountIn,
              minOut,
              gasData
            );

      this.publishReceipt(receipt);
    }

    this.eventStream?.publishExecutionStatus({
      source: "executor",
      opportunityId: opportunity.label,
      mode: "multi_hop",
      status: "confirmed",
      detail: route.routeId,
    });
    return true;
  }

  private publishReceipt(receipt: ethers.TransactionReceipt): void {
    this.eventStream?.publishReceipt(
      {
        txHash: receipt.hash,
        receiptStatus: receipt.status === 1,
        confirmedBlock: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        rawReceipt: {},
        effectiveGasPrice: receipt.gasPrice?.toString() ?? "0",
        gasCostWei: ((receipt.gasPrice ?? 0n) * receipt.gasUsed).toString(),
        from: receipt.from,
        to: receipt.to ?? "",
        logs: [],
      },
      "executor"
    );
  }

  /**
   * Executes an arbitrage opportunity atomically via an Aave V3 flash loan.
   *
   * The flash loan borrows `tradeAmountIn` of tokenIn, passes encoded swap
   * instructions to a deployed FlashLoanExecutor contract via the `params`
   * argument, which then performs both swap legs inside `executeOperation()`
   * and repays the loan + fee in a single transaction.
   *
   * SCAFFOLD: Requires FLASH_EXECUTOR_ADDRESS to be set in the environment.
   * The FlashLoanExecutor contract must implement IFlashLoanSimpleReceiver
   * and decode the params struct below.
   *
   * Params ABI type (decoded by the receiver):
   *   tuple(
   *     address tokenIn,
   *     address tokenOut,
   *     address buyRouter,
   *     address sellRouter,
   *     uint256 amountIn,
   *     uint256 minOut1,
   *     uint256 minOut2,
   *     uint8   buyRouterType,   // 0 = UniV2, 1 = UniV3
   *     uint8   sellRouterType,  // 0 = UniV2, 1 = UniV3
   *     uint24  buyFee,
   *     uint24  sellFee
   *   )
   */
  async executeAtomic(opportunity: ArbitrageOpportunity): Promise<boolean> {
    const flashExecutorAddr = process.env["FLASH_EXECUTOR_ADDRESS"];
    if (!flashExecutorAddr) {
      logger.warn(
        "FLASH_EXECUTOR_ADDRESS not configured — atomic execution unavailable"
      );
      return false;
    }

    if (!checkCircuitBreaker()) {
      logger.warn("Circuit breaker OPEN — skipping atomic execution");
      return false;
    }

    const { buyQuote, sellQuote, tradeAmountIn, label } = opportunity;
    logger.info("Executing atomic flash opportunity", {
      label,
      netProfitUsd: opportunity.netProfitUsd.toFixed(2),
    });

    try {
      const gasData = await getGasData(this.provider);

      const tokenInCfg = TOKENS[buyQuote.tokenIn]!;
      const tokenOutCfg = TOKENS[buyQuote.tokenOut]!;
      const slippageFactor = 1 - MAX_SLIPPAGE;

      const buyDexCfg = DEXES.find((d) => d.name === buyQuote.dex)!;
      const sellDexCfg = DEXES.find((d) => d.name === sellQuote.dex)!;

      // Router type flag: 0 = UniV2, 1 = UniV3, 2 = Balancer
      const buyRouterType = buyDexCfg.type === "UniV3" ? 1 : buyDexCfg.type === "Balancer" ? 2 : 0;
      const sellRouterType = sellDexCfg.type === "UniV3" ? 1 : sellDexCfg.type === "Balancer" ? 2 : 0;

      // Fee tier only applies to UniV2/UniV3 routers; Balancer uses 0 (fee is
      // embedded in the pool ID and handled by the vault internally)
      const buyFee =
        buyDexCfg.type === "Balancer"
          ? 0
          : (buyDexCfg.feeTiers?.[0] ?? buyDexCfg.defaultFee ?? 3000);
      const sellFee =
        sellDexCfg.type === "Balancer"
          ? 0
          : (sellDexCfg.feeTiers?.[0] ?? sellDexCfg.defaultFee ?? 3000);

      const minOut1 = BigInt(
        Math.floor(Number(buyQuote.amountOut) * slippageFactor)
      );
      const minOut2 = BigInt(
        Math.floor(Number(sellQuote.amountOut) * slippageFactor)
      );

      // Encode the two-leg swap instructions for the FlashLoanExecutor callback
      const abiCoder = ethers.AbiCoder.defaultAbiCoder();
      const flashLoanParams = abiCoder.encode(
        [
          "tuple(address tokenIn, address tokenOut, address buyRouter, address sellRouter, uint256 amountIn, uint256 minOut1, uint256 minOut2, uint8 buyRouterType, uint8 sellRouterType, uint24 buyFee, uint24 sellFee)",
        ],
        [
          {
            tokenIn: tokenInCfg.address,
            tokenOut: tokenOutCfg.address,
            buyRouter: buyDexCfg.router,
            sellRouter: sellDexCfg.router,
            amountIn: tradeAmountIn,
            minOut1,
            minOut2,
            buyRouterType,
            sellRouterType,
            buyFee,
            sellFee,
          },
        ]
      );

      const aavePool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, this.wallet);
      const tx: ethers.TransactionResponse = await aavePool.flashLoan(
        flashExecutorAddr,         // receiver — our FlashLoanExecutor contract
        [tokenInCfg.address],      // assets to borrow
        [tradeAmountIn],           // amounts
        [0],                       // 0 = no open debt (standard flash loan)
        flashExecutorAddr,         // onBehalfOf
        flashLoanParams,           // encoded swap instructions
        0,                         // referralCode
        {
          maxFeePerGas: gasData.maxFeePerGas,
          maxPriorityFeePerGas: gasData.maxPriorityFee,
        }
      );

      logger.info("Atomic flash loan submitted", { hash: tx.hash });
      this.eventStream?.publishHealth(
        "execution",
        "ok",
        `Flash loan submitted: ${tx.hash}`,
        "executor"
      );

      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        throw new Error(`Atomic execution reverted: ${tx.hash}`);
      }

      logger.info("Atomic execution confirmed", {
        hash: receipt.hash,
        gas: receipt.gasUsed.toString(),
      });
      this.eventStream?.publishReceipt(
        {
          txHash: receipt.hash,
          receiptStatus: receipt.status === 1,
          confirmedBlock: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          rawReceipt: {},
          effectiveGasPrice: receipt.gasPrice?.toString() ?? "0",
          gasCostWei: (
            (receipt.gasPrice ?? 0n) * receipt.gasUsed
          ).toString(),
          from: receipt.from,
          to: receipt.to ?? "",
          logs: [],
        },
        "executor"
      );

      recordSuccess();
      return true;
    } catch (err) {
      logger.error("Atomic execution failed", { label, err: String(err) });
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
