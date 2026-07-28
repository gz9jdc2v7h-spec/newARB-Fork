import "dotenv/config";
import { ethers } from "ethers";
import {
  RPC_HTTP,
  RPC_HTTP_FALLBACK,
  RPC_WS,
  CHAIN_ID,
} from "./config";
import { OpportunityScanner, PairQuotes } from "./discovery/OpportunityScanner";
import { OpportunityRanker } from "./ranking/OpportunityRanker";
import { Executor } from "./execution/Executor";
import { logger } from "./utils/logger";
import { sleep } from "./utils/helpers";

// ─── Provider setup ───────────────────────────────────────────────────────────

function createHttpProvider(): ethers.JsonRpcProvider {
  try {
    const p = new ethers.JsonRpcProvider(RPC_HTTP, CHAIN_ID);
    logger.info("HTTP provider created", { url: RPC_HTTP });
    return p;
  } catch {
    logger.warn("Primary RPC failed — using fallback", {
      fallback: RPC_HTTP_FALLBACK,
    });
    return new ethers.JsonRpcProvider(RPC_HTTP_FALLBACK, CHAIN_ID);
  }
}

function createWsProvider(): ethers.WebSocketProvider | null {
  if (!RPC_WS) return null;
  try {
    const p = new ethers.WebSocketProvider(RPC_WS, CHAIN_ID);
    logger.info("WebSocket provider created", { url: RPC_WS });
    return p;
  } catch (err) {
    logger.warn("WebSocket provider failed — will use HTTP polling", {
      err: String(err),
    });
    return null;
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info("=== ARB Bot starting ===");

  const httpProvider = createHttpProvider();
  const wsProvider = createWsProvider();

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
    executor = new Executor(httpProvider);
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
      });

      if (executor) {
        await executor.execute(best);
      }
    } finally {
      processing = false;
    }
  };

  const scanner = new OpportunityScanner(httpProvider, wsProvider, handleSnapshot);
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
