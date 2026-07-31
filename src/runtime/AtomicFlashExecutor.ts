import { keccak256, toUtf8Bytes } from "ethers";
import type { ArbitrageOpportunity } from "../ranking/OpportunityRanker";
import {
  AAVE_POOL,
  CHAIN_ID,
  FLASH_EXECUTOR_ADDRESS,
  FLASH_MAX_ROUTE_STEPS,
  FLASH_SIGNER_PRIVATE_KEY,
  PRIVATE_RELAY_ENDPOINT,
  PRIVATE_RELAY_NAME,
  PUBLIC_FALLBACK,
  TOKENS,
} from "../config";
import { ApexTxSubmitter } from "../submitter/ApexTxSubmitter";
import { C1Engine, C1FlashProvider } from "../pipeline/c1/C1Engine";
import type { ConfigRecord, RouteRecord, StateRecord } from "../types";
import { RuntimeEventStream } from "./RuntimeEventStream";

export class AtomicFlashExecutor {
  private readonly c1Engine: C1Engine;

  constructor(private readonly eventStream?: RuntimeEventStream) {
    const submitter = new ApexTxSubmitter({
      rpcUrl: process.env["POLYGON_RPC_HTTP"] ?? "https://polygon-rpc.com",
      chainId: CHAIN_ID,
      relay: PRIVATE_RELAY_ENDPOINT
        ? {
            endpoint: PRIVATE_RELAY_ENDPOINT,
            relayName: PRIVATE_RELAY_NAME,
          }
        : undefined,
    });
    this.c1Engine = new C1Engine(submitter);
  }

  async execute(opportunity: ArbitrageOpportunity, currentBlock: number): Promise<boolean> {
    if (!FLASH_EXECUTOR_ADDRESS || !FLASH_SIGNER_PRIVATE_KEY) {
      this.eventStream?.publishExecutionStatus({
        source: "risk",
        opportunityId: opportunity.label,
        mode: "atomic_flash",
        status: "cancelled",
        detail: "missing flash executor config",
      });
      return false;
    }

    const route = this.buildRouteRecord(opportunity);
    if (route.steps.length === 0 || route.steps.length > FLASH_MAX_ROUTE_STEPS) {
      this.eventStream?.publishExecutionStatus({
        source: "risk",
        opportunityId: opportunity.label,
        mode: "atomic_flash",
        status: "cancelled",
        detail: "route not executable",
      });
      return false;
    }

    const configRecord = this.buildConfigRecord();
    const stateRecord = this.buildStateRecord(opportunity, currentBlock);
    const flashProvider: C1FlashProvider = route.steps.some((s) => s.venue.includes("Balancer"))
      ? "balancer"
      : "aave";

    try {
      const result = await this.c1Engine.execute({
        opportunityId: opportunity.label,
        cycleId: `c1-${Date.now()}`,
        config: configRecord,
        state: stateRecord,
        route,
        executor: FLASH_EXECUTOR_ADDRESS,
        flashProvider,
        encodedRoutePayload: this.encodeRoute(route),
        borrowAsset: TOKENS[opportunity.tokenBase]?.address ?? AAVE_POOL,
        borrowAmount: opportunity.tradeAmountIn,
        minFinalAmount: opportunity.tradeAmountIn,
        deadline: Math.floor(Date.now() / 1000) + 120,
        signerPrivateKey: FLASH_SIGNER_PRIVATE_KEY,
        gasLimit: 900_000n,
        maxFeePerGas: 150_000_000_000n,
        maxPriorityFeePerGas: 30_000_000_000n,
        expiresAtBlock: currentBlock + 2,
        relayEndpoint: PRIVATE_RELAY_ENDPOINT,
        publicFallback: PUBLIC_FALLBACK,
        opportunityHash: keccak256(toUtf8Bytes(opportunity.label)),
        payloadHash: keccak256(toUtf8Bytes(this.encodeRoute(route))),
        stateHash: stateRecord.stateHash,
      });

      this.eventStream?.publishExecutionStatus({
        source: "submitter",
        opportunityId: opportunity.label,
        mode: "atomic_flash",
        status: "submitted",
        detail: result.submission.txHash,
      });

      this.eventStream?.publishExecutionStatus({
        source: "executor",
        opportunityId: opportunity.label,
        mode: "atomic_flash",
        status: result.receipt.receiptStatus ? "confirmed" : "reverted",
        detail: result.receipt.txHash,
      });

      return result.receipt.receiptStatus;
    } catch (err) {
      this.eventStream?.publishExecutionStatus({
        source: "risk",
        opportunityId: opportunity.label,
        mode: "atomic_flash",
        status: "reverted",
        detail: String(err),
      });
      return false;
    }
  }

  private buildRouteRecord(opportunity: ArbitrageOpportunity): RouteRecord {
    if (opportunity.multiHopRoute?.valid) {
      return {
        borrowAsset: TOKENS[opportunity.tokenBase]?.address ?? opportunity.tokenBase,
        borrowAmount: opportunity.tradeAmountIn.toString(),
        steps: opportunity.multiHopRoute.steps.map((step, idx) => ({
          venue: step.dex,
          pool: `${step.dex}:${idx}`,
          tokenIn: step.tokenIn,
          tokenOut: step.tokenOut,
          amountIn: step.amountIn,
          expectedOut: step.expectedOut,
        })),
        minOut: opportunity.multiHopRoute.expectedFinalAmountOut,
        deadline: Math.floor(Date.now() / 1000) + 120,
        routeHash: keccak256(toUtf8Bytes(opportunity.multiHopRoute.routeId)),
      };
    }

    return {
      borrowAsset: TOKENS[opportunity.tokenBase]?.address ?? opportunity.tokenBase,
      borrowAmount: opportunity.tradeAmountIn.toString(),
      steps: [
        {
          venue: opportunity.sellQuote.dex,
          pool: `${opportunity.sellQuote.dex}:sell`,
          tokenIn: opportunity.sellQuote.tokenIn,
          tokenOut: opportunity.sellQuote.tokenOut,
          amountIn: opportunity.tradeAmountIn.toString(),
          expectedOut: opportunity.sellQuote.amountOut.toString(),
        },
        {
          venue: opportunity.buyQuote.dex,
          pool: `${opportunity.buyQuote.dex}:buy`,
          tokenIn: opportunity.buyQuote.tokenOut,
          tokenOut: opportunity.buyQuote.tokenIn,
          amountIn: opportunity.sellQuote.amountOut.toString(),
          expectedOut: opportunity.tradeAmountIn.toString(),
        },
      ],
      minOut: opportunity.tradeAmountIn.toString(),
      deadline: Math.floor(Date.now() / 1000) + 120,
      routeHash: keccak256(toUtf8Bytes(opportunity.label)),
    };
  }

  private buildConfigRecord(): ConfigRecord {
    const configHash = keccak256(toUtf8Bytes("atomic-flash-config"));
    return {
      configVersion: 1,
      configHash,
      mode: "live",
      minNetProfitUsd: "0",
      minProfitToGasRatio: "0",
      maxPoolUsageRatio: "1",
      privateRelayFirst: Boolean(PRIVATE_RELAY_ENDPOINT),
      publicFallback: PUBLIC_FALLBACK,
      killSwitch: false,
      c2Enabled: false,
      enabledVenues: ["UniswapV3", "SushiSwapV2", "QuickSwapV2", "BalancerV2", "Curve"],
      enabledAssets: ["WMATIC", "WETH", "USDC", "USDT", "DAI", "WBTC"],
      gasCap: "0",
    };
  }

  private buildStateRecord(opportunity: ArbitrageOpportunity, blockNumber: number): StateRecord {
    const statePayload = {
      blockNumber,
      buyPool: opportunity.buyQuote.dex,
      sellPool: opportunity.sellQuote.dex,
      token0: opportunity.tokenBase,
      token1: opportunity.tokenQuote,
    };

    return {
      chainId: CHAIN_ID,
      blockNumber,
      blockHash: "0x0",
      buyPool: opportunity.buyQuote.dex,
      sellPool: opportunity.sellQuote.dex,
      poolFamily: opportunity.invariantFamilies.join(","),
      token0: opportunity.tokenBase,
      token1: opportunity.tokenQuote,
      stateHash: keccak256(toUtf8Bytes(JSON.stringify(statePayload))),
      observedAtMs: Date.now(),
      stateAgeBlocks: 0,
      maxStateAgeBlocks: 2,
    };
  }

  private encodeRoute(route: RouteRecord): string {
    return `0x${Buffer.from(JSON.stringify(route), "utf8").toString("hex")}`;
  }
}
