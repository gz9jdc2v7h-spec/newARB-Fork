import { ENABLE_PRODUCTION_OBSERVABILITY } from "../config";
import type { ArbitrageOpportunity } from "../ranking/OpportunityRanker";
import { AuditLogger } from "../pipeline/transparency/AuditLogger";
import type {
  ConfigRecord,
  ExecutionDecisionRecord,
  ProfitRecord,
  RouteRecord,
  StateRecord,
} from "../types";
import { RuntimeEventStream } from "./RuntimeEventStream";

export class ObservabilityReporter {
  private readonly logger = new AuditLogger();
  private readonly counters = {
    opportunitiesSeen: 0,
    opportunitiesExecuted: 0,
    opportunitiesRejected: 0,
  };

  constructor(private readonly eventStream: RuntimeEventStream) {}

  recordDiscovery(opportunity: ArbitrageOpportunity): void {
    if (!ENABLE_PRODUCTION_OBSERVABILITY) return;
    this.counters.opportunitiesSeen += 1;

    const state: StateRecord = {
      chainId: 137,
      blockNumber: 0,
      blockHash: "0x0",
      buyPool: opportunity.buyQuote.dex,
      sellPool: opportunity.sellQuote.dex,
      poolFamily: opportunity.invariantFamilies.join(","),
      token0: opportunity.tokenBase,
      token1: opportunity.tokenQuote,
      stateHash: `obs-${opportunity.label}`,
      observedAtMs: Date.now(),
      stateAgeBlocks: 0,
      maxStateAgeBlocks: 2,
    };

    const route: RouteRecord = {
      borrowAsset: opportunity.tokenBase,
      borrowAmount: opportunity.tradeAmountIn.toString(),
      steps: [
        {
          venue: opportunity.sellQuote.dex,
          pool: opportunity.sellQuote.dex,
          tokenIn: opportunity.sellQuote.tokenIn,
          tokenOut: opportunity.sellQuote.tokenOut,
          amountIn: opportunity.tradeAmountIn.toString(),
          expectedOut: opportunity.sellQuote.amountOut.toString(),
        },
      ],
      minOut: opportunity.tradeAmountIn.toString(),
      deadline: Math.floor(Date.now() / 1000) + 120,
      routeHash: `route-${opportunity.label}`,
    };

    const profit: ProfitRecord = {
      expectedGrossUsd: opportunity.grossProfitUsd.toFixed(6),
      flashFeeUsd: "0",
      dexFeeUsd: "0",
      gasEstimateUsd: opportunity.gasCostUsd.toFixed(6),
      riskBufferUsd: "0",
      mevBufferUsd: "0",
      expectedNetUsd: opportunity.netProfitUsd.toFixed(6),
      sizingMethod: opportunity.sizingMethod,
      invariantFamilies: opportunity.invariantFamilies,
    };

    this.logger.logState(opportunity.label, state);
    this.logger.logRoute(opportunity.label, route);
    this.logger.logProfit(opportunity.label, profit);
  }

  recordDecision(opportunityId: string, decision: ExecutionDecisionRecord): void {
    if (!ENABLE_PRODUCTION_OBSERVABILITY) return;
    if (decision.shouldExecute) {
      this.counters.opportunitiesExecuted += 1;
    } else {
      this.counters.opportunitiesRejected += 1;
    }

    this.logger.logPayload(opportunityId, {
      payloadStatus: "BUILT",
      executor: decision.mode,
      method: "execution_decision",
      selector: "0x00000000",
      opportunityHash: opportunityId,
      routeHash: opportunityId,
      stateHash: opportunityId,
      configHash: "observability",
      payloadHash: JSON.stringify(decision),
    });
  }

  publishHealth(): void {
    if (!ENABLE_PRODUCTION_OBSERVABILITY) return;
    const status = this.eventStream.executionStatusSnapshot();
    const detail = JSON.stringify({
      ...this.counters,
      executionStatus: status,
    });

    this.eventStream.publishHealth(
      "execution",
      this.counters.opportunitiesRejected > this.counters.opportunitiesExecuted * 2
        ? "degraded"
        : "ok",
      detail,
      "risk"
    );
  }

  logConfig(config: ConfigRecord, opportunityId = "runtime"): void {
    if (!ENABLE_PRODUCTION_OBSERVABILITY) return;
    this.logger.logConfig(opportunityId, config);
  }
}
