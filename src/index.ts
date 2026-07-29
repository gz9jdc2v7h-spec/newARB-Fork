import "dotenv/config";
import { ethers } from "ethers";
import {
  RPC_HTTP_CANDIDATES,
  RPC_WS_CANDIDATES,
  CHAIN_ID,
} from "./config";
import { OpportunityScanner, PairQuotes } from "./discovery/OpportunityScanner";
import { OpportunityRanker } from "./ranking/OpportunityRanker";
import { Executor } from "./execution/Executor";
import { logger } from "./utils/logger";
import { sleep } from "./utils/helpers";
import { RuntimeEventStream } from "./runtime/RuntimeEventStream";
import { assessOpportunityRisk } from "./runtime/RiskControls";
import { decideExecutionMode } from "./runtime/ExecutionPolicy";

// ─── Provider setup ───────────────────────────────────────────────────────────

async function createHttpProvider(): Promise<ethers.JsonRpcProvider> {
  let lastErr: unknown;
  for (const url of RPC_HTTP_CANDIDATES) {
    try {
      const p = new ethers.JsonRpcProvider(url, CHAIN_ID);
      const network = await p.getNetwork();
      if (network.chainId !== BigInt(CHAIN_ID)) {
        throw new Error(`Endpoint ${url} is chain ${network.chainId}, expected ${CHAIN_ID}`);
      }
      logger.info("HTTP provider selected", { url });
      return p;
    } catch (err) {
      lastErr = err;
      logger.warn("HTTP endpoint unavailable", { url, err: String(err) });
    }
  }
  throw new Error(`No reachable HTTP Polygon endpoint. Last error: ${String(lastErr)}`);
}

async function createWsProvider(): Promise<ethers.WebSocketProvider | null> {
  for (const url of RPC_WS_CANDIDATES) {
    try {
      const p = new ethers.WebSocketProvider(url, CHAIN_ID);
      const block = await p.getBlockNumber();
      logger.info("WebSocket provider selected", { url, block });
      return p;
    } catch (err) {
      logger.warn("WebSocket endpoint unavailable", { url, err: String(err) });
    }
  }
  logger.warn("No reachable WebSocket endpoint — will use HTTP polling");
  return null;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info("=== Polygon ARB Bot starting ===");

  const httpProvider = await createHttpProvider();
  const wsProvider = await createWsProvider();
  const eventStream = new RuntimeEventStream();
  eventStream.on((event) => {
    if (event.kind === "health" && event.status !== "ok") {
      logger.warn("Runtime event", event);
    } else if (event.kind !== "pending_tx") {
      logger.debug("Runtime event", event);
    }
  });

  // Verify network
  const network = await httpProvider.getNetwork();
  if (network.chainId !== BigInt(CHAIN_ID)) {
    throw new Error(
      `Wrong network: expected chain ${CHAIN_ID}, got ${network.chainId}`
    );
  }
  logger.info(`Connected to chain ${network.chainId} (${network.name})`);

  const ranker = new OpportunityRanker(httpProvider);

  // Only create executor when PRIVATE_KEY is set
  let executor: Executor | null = null;
  if (process.env["PRIVATE_KEY"]) {
    executor = new Executor(httpProvider, eventStream);
    logger.info("Executor initialised — LIVE execution enabled");
  } else {
    logger.warn(
      "PRIVATE_KEY not set — running in DRY-RUN mode (discovery + ranking only)"
    );
  }

  // Debounce: ensure we don't process overlapping snapshots
  let processing = false;

  const handleSnapshot = async (snapshot: PairQuotes[]): Promise<void> => {
    if (processing) {
      logger.debug("Skipping snapshot — previous still processing");
      return;
    }
    processing = true;
    try {
      const opportunities = await ranker.rank(snapshot);
      if (opportunities.length === 0) {
        logger.debug("No profitable opportunities found");
        return;
      }

      const best = opportunities[0]!;
      logger.info("Best opportunity", {
        label: best.label,
        grossUsd: best.grossProfitUsd.toFixed(2),
        gasUsd: best.gasCostUsd.toFixed(2),
        netUsd: best.netProfitUsd.toFixed(2),
        score: best.score.toFixed(2),
        invariantFamilies: best.invariantFamilies,
        sizingMethod: best.sizingMethod,
        quoteAgeMs: best.quoteAgeMs,
      });

      if (executor) {
        const risk = assessOpportunityRisk(best);
        const decision = decideExecutionMode({
          hasPrivateKey: Boolean(process.env["PRIVATE_KEY"]),
          routeKind: best.routeKind,
          requiresFlashLoan: best.routeKind === "multi_hop",
          quoteAgeMs: best.quoteAgeMs,
          supportsPrivateRelay: true,
          supportsAtomicFlash: false,
          expectedNetProfitUsd: best.netProfitUsd,
          riskFlags: risk.flags,
        });
        logger.info("Execution decision", decision);
        if (decision.shouldExecute && decision.mode === "sequential_live") {
          await executor.execute(best);
        } else if (!decision.shouldExecute) {
          eventStream.publishHealth(
            "risk",
            "paused",
            `Execution paused: ${decision.rationale} (${decision.riskFlags.join(",") || "no-flags"})`,
            "risk"
          );
        }
      }
    } finally {
      processing = false;
    }
  };

  const scanner = new OpportunityScanner(httpProvider, wsProvider, handleSnapshot, eventStream);
  scanner.start();

  // Keep alive — handle graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    scanner.stop();
    if (wsProvider) {
      await wsProvider.destroy();
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // In dry-run mode without WebSocket, the polling loop in OpportunityScanner
  // keeps the process alive. With WebSocket subscriptions the event listener
  // keeps the process alive. Either way we block here.
  while (true) {
    await sleep(60_000);
    logger.debug("Heartbeat — bot is running");
  }
}

main().catch((err) => {
  logger.error("Fatal error", { err: String(err) });
  process.exit(1);
});
