import { ethers } from "ethers";
import { DEXES, SCAN_PAIRS, TOKENS, DISCOVERY_WORKERS } from "../config";
import { pLimit } from "../utils/helpers";
import { logger } from "../utils/logger";
import { fetchQuote, PriceQuote } from "./PriceFeeder";

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

  constructor(
    provider: ethers.Provider,
    wsProvider: ethers.WebSocketProvider | null,
    onSnapshot: (snapshot: PairQuotes[]) => Promise<void>
  ) {
    this.provider = provider;
    this.wsProvider = wsProvider;
    this.onSnapshot = onSnapshot;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const scanAndEmit = async () => {
      if (!this.running) return;
      const snapshot = await scanAllPairs(this.provider).catch((err) => {
        logger.error("Scan error", { err: String(err) });
        return [] as PairQuotes[];
      });
      if (snapshot.length > 0) {
        await this.onSnapshot(snapshot).catch((err) =>
          logger.error("Snapshot handler error", { err: String(err) })
        );
      }
    };

    if (this.wsProvider) {
      logger.info("Using WebSocket subscription for block events");
      this.wsProvider.on("block", async (blockNumber: number) => {
        logger.debug(`New block: ${blockNumber}`);
        await scanAndEmit();
      });
    } else {
      logger.info("WebSocket unavailable — falling back to HTTP polling");
      const poll = async () => {
        while (this.running) {
          await scanAndEmit();
          // Poll interval is handled by the block time; no extra sleep needed
          // unless we want throttling below block time.
          await new Promise<void>((r) => setTimeout(r, 500));
        }
      };
      poll();
    }
  }

  stop(): void {
    this.running = false;
    if (this.wsProvider) {
      this.wsProvider.removeAllListeners("block");
    }
  }
}
