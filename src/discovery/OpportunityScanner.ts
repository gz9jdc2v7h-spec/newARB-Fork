import { ethers } from "ethers";
import {
  DEXES,
  SCAN_PAIRS,
  TOKENS,
  DISCOVERY_WORKERS,
  ENABLE_PENDING_FEED,
  MAX_PENDING_TX_PER_BLOCK,
  POLL_INTERVAL_MS,
} from "../config";
import { pLimit } from "../utils/helpers";
import { logger } from "../utils/logger";
import { fetchQuote, PriceQuote } from "./PriceFeeder";
import { RuntimeEventStream } from "../runtime/RuntimeEventStream";
import { MempoolFilter } from "./MempoolFilter";

export interface PairQuotes {
  tokenIn: string;
  tokenOut: string;
  quotes: PriceQuote[];
}

/**
 * Scans all configured DEX/pair combinations in parallel and
 * returns the full price matrix for the current block.
 */
export async function scanAllPairs(
  provider: ethers.Provider
): Promise<PairQuotes[]> {
  // Build flat task list: one task per (dex, pair) combination
  const tasks: Array<{
    dex: (typeof DEXES)[number];
    tokenIn: string;
    tokenOut: string;
  }> = [];

  for (const [tokenIn, tokenOut] of SCAN_PAIRS) {
    for (const dex of DEXES) {
      tasks.push({ dex, tokenIn, tokenOut });
    }
  }

  logger.debug(`Scanning ${tasks.length} (dex, pair) combinations`, {
    workers: DISCOVERY_WORKERS,
  });

  const results = await pLimit(
    tasks.map(
      ({ dex, tokenIn, tokenOut }) =>
        () =>
          fetchQuote(provider, dex, tokenIn, tokenOut).catch((err) => {
            logger.debug(`Quote failed`, { dex: dex.name, tokenIn, tokenOut, err: String(err) });
            return null;
          })
    ),
    DISCOVERY_WORKERS
  );

  // Group by pair
  const byPair = new Map<string, PriceQuote[]>();
  for (let i = 0; i < tasks.length; i++) {
    const { tokenIn, tokenOut } = tasks[i]!;
    const key = `${tokenIn}/${tokenOut}`;
    const quote = results[i];
    if (!quote) continue;
    const arr = byPair.get(key) ?? [];
    arr.push(quote);
    byPair.set(key, arr);
  }

  const pairQuotes: PairQuotes[] = [];
  for (const [key, quotes] of byPair) {
    const [tokenIn, tokenOut] = key.split("/") as [string, string];
    pairQuotes.push({ tokenIn, tokenOut, quotes });
  }

  logger.debug(`Scan complete`, {
    pairs: pairQuotes.length,
    totalQuotes: pairQuotes.reduce((s, p) => s + p.quotes.length, 0),
  });

  return pairQuotes;
}

/**
 * OpportunityScanner subscribes to new blocks (or polls) and emits
 * fresh price snapshots for the ranking layer.
 */
export class OpportunityScanner {
  private provider: ethers.Provider;
  private wsProvider: ethers.WebSocketProvider | null = null;
  private onSnapshot: (snapshot: PairQuotes[]) => Promise<void>;
  private running = false;
  private readonly eventStream?: RuntimeEventStream;
  private lastPolledBlock: number | null = null;
  private mempoolFilter: MempoolFilter | null = null;

  constructor(
    provider: ethers.Provider,
    wsProvider: ethers.WebSocketProvider | null,
    onSnapshot: (snapshot: PairQuotes[]) => Promise<void>,
    eventStream?: RuntimeEventStream
  ) {
    this.provider = provider;
    this.wsProvider = wsProvider;
    this.onSnapshot = onSnapshot;
    this.eventStream = eventStream;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const scanAndEmit = async () => {
      if (!this.running) return;
      const snapshot = await scanAllPairs(this.provider).catch((err) => {
        logger.error("Scan error", { err: String(err) });
        this.eventStream?.publishHealth("http", "degraded", String(err), "scanner");
        return [] as PairQuotes[];
      });
      if (snapshot.length > 0) {
        this.eventStream?.publishPoolUpdate(snapshot, "scanner");
        await this.onSnapshot(snapshot).catch((err) =>
          logger.error("Snapshot handler error", { err: String(err) })
        );
      }
    };

    if (this.wsProvider) {
      logger.info("Using WebSocket subscription for block events");

      // ── Mempool filter setup ──────────────────────────────────────────────
      if (ENABLE_PENDING_FEED && this.eventStream) {
        const routerAddresses = DEXES.map((d) => d.router);
        this.mempoolFilter = new MempoolFilter(
          this.provider,
          this.eventStream,
          routerAddresses,
          MAX_PENDING_TX_PER_BLOCK
        );
        this.wsProvider.on("pending", (txHash: string) => {
          try {
            this.mempoolFilter!.ingest(txHash);
          } catch (err) {
            logger.debug("Pending feed error", { txHash, err: String(err) });
          }
        });
        this.eventStream.publishHealth(
          "ws",
          "ok",
          "Mempool filter active with swap-selector and router filtering",
          "ws_pending"
        );
      } else if (ENABLE_PENDING_FEED) {
        // Fallback: no eventStream — use raw publish (preserves backward compat)
        this.wsProvider.on("pending", (txHash: string) => {
          try {
            const accepted =
              this.eventStream?.publishPendingTx(
                txHash,
                "ws_pending",
                MAX_PENDING_TX_PER_BLOCK
              ) ?? false;
            if (!accepted) {
              logger.debug("Pending tx dropped by backpressure", {
                txHash,
                maxPerBlock: MAX_PENDING_TX_PER_BLOCK,
              });
            }
          } catch (err) {
            logger.debug("Pending feed error", { txHash, err: String(err) });
          }
        });
      }

      // ── Block subscription ────────────────────────────────────────────────
      this.wsProvider.on("block", async (blockNumber: number) => {
        this.eventStream?.publishBlock(blockNumber, "ws_block");
        logger.debug(`New block: ${blockNumber}`);
        // Reset mempool filter counters for the new block
        this.mempoolFilter?.onNewBlock();
        await scanAndEmit();
      });

      this.eventStream?.publishHealth("ws", "ok", "WebSocket block feed active", "ws_block");
    } else {
      logger.info("WebSocket unavailable — falling back to HTTP polling");
      this.eventStream?.publishHealth(
        "ws",
        "degraded",
        "WebSocket unavailable, using HTTP polling",
        "http_poll"
      );
      const poll = async () => {
        while (this.running) {
          try {
            const blockNumber = await this.provider.getBlockNumber();
            if (this.lastPolledBlock !== blockNumber) {
              this.lastPolledBlock = blockNumber;
              this.eventStream?.publishBlock(blockNumber, "http_poll");
            }
          } catch (err) {
            logger.debug("Block poll failed", { err: String(err) });
          }
          await scanAndEmit();
          await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
      };
      poll();
    }
  }

  stop(): void {
    this.running = false;
    this.mempoolFilter?.destroy();
    this.mempoolFilter = null;
    if (this.wsProvider) {
      this.wsProvider.removeAllListeners("block");
      this.wsProvider.removeAllListeners("pending");
    }
  }
}
