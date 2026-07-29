import { ethers } from "ethers";
import { logger } from "../utils/logger";
import type { RuntimeEventStream } from "../runtime/RuntimeEventStream";

// ─── Known 4-byte swap function selectors ────────────────────────────────────
// Covers UniV2, UniV3, and Balancer V2 swap entrypoints.
const SWAP_SELECTORS = new Set([
  "38ed1739", // swapExactTokensForTokens (UniV2)
  "8803dbee", // swapTokensForExactTokens (UniV2)
  "7ff36ab5", // swapExactETHForTokens (UniV2)
  "18cbafe5", // swapExactTokensForETH (UniV2)
  "fb3bdb41", // swapETHForExactTokens (UniV2)
  "414bf389", // exactInputSingle (UniV3)
  "c04b8d59", // exactInput (UniV3)
  "db3e2198", // exactOutputSingle (UniV3)
  "09b81346", // exactOutput (UniV3)
  "945bcec9", // batchSwap (Balancer V2 Vault)
  "52bbbe29", // swap (Balancer V2 single)
]);

export interface MempoolFilterOptions {
  /** Max pending tx hashes to batch before forcing an immediate flush (default: 16). */
  batchSize?: number;
  /** Flush interval in ms when the batch hasn't reached batchSize (default: 250). */
  flushIntervalMs?: number;
  /** Upper bound on the deduplication set size per block to cap memory usage (default: 4096). */
  maxDedupeSize?: number;
}

/**
 * MempoolFilter decodes pending transaction hashes from a WebSocket
 * "pending" subscription to identify swap transactions on known DEX routers.
 *
 * Key hardening properties:
 *  - Per-block deduplication: a tx hash received multiple times in the same
 *    block is only fetched and processed once.
 *  - Bounded memory: the deduplication set is capped to avoid unbounded growth.
 *  - Batched RPC fetches: pending hashes are accumulated and flushed as a
 *    batch, keeping per-event RPC fan-out predictable.
 *  - Error isolation: a failed getTransaction call for one hash does not affect
 *    other hashes in the same batch.
 *  - Per-block acceptance cap: at most maxPerBlock events are published to the
 *    RuntimeEventStream per block cycle, matching the existing backpressure limit.
 */
export class MempoolFilter {
  private readonly provider: ethers.Provider;
  private readonly eventStream: RuntimeEventStream;
  private readonly routerAddresses: Set<string>;
  private readonly maxPerBlock: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxDedupeSize: number;

  private seenThisBlock = new Set<string>();
  private pendingBatch: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private acceptedThisBlock = 0;

  constructor(
    provider: ethers.Provider,
    eventStream: RuntimeEventStream,
    routerAddresses: string[],
    maxPerBlock: number,
    options?: MempoolFilterOptions
  ) {
    this.provider = provider;
    this.eventStream = eventStream;
    this.routerAddresses = new Set(routerAddresses.map((a) => a.toLowerCase()));
    this.maxPerBlock = maxPerBlock;
    this.batchSize = options?.batchSize ?? 16;
    this.flushIntervalMs = options?.flushIntervalMs ?? 250;
    this.maxDedupeSize = options?.maxDedupeSize ?? 4096;
  }

  /** Reset per-block counters. Call this whenever a new block is observed. */
  onNewBlock(): void {
    this.seenThisBlock.clear();
    this.acceptedThisBlock = 0;
  }

  /**
   * Ingest a pending tx hash from the WebSocket subscription.
   * Returns false when the per-block acceptance cap has already been reached.
   */
  ingest(txHash: string): boolean {
    if (this.acceptedThisBlock >= this.maxPerBlock) return false;

    // Deduplicate within this block. Once the set reaches maxDedupeSize we
    // stop tracking new hashes to prevent memory growth, but still accept them.
    if (this.seenThisBlock.size < this.maxDedupeSize) {
      if (this.seenThisBlock.has(txHash)) return true;
      this.seenThisBlock.add(txHash);
    }

    this.pendingBatch.push(txHash);

    if (this.pendingBatch.length >= this.batchSize) {
      this.flushBatch();
    } else if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flushBatch(), this.flushIntervalMs);
    }

    return true;
  }

  private flushBatch(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch = this.pendingBatch.splice(0);
    if (batch.length === 0) return;

    // Fire-and-forget: this runs inside a WebSocket event listener where we
    // must not block. Individual fetch failures are isolated by allSettled so
    // an error from one hash never aborts the rest of the batch.
    void Promise.allSettled(batch.map((h) => this.classifyTx(h)));
  }

  private async classifyTx(txHash: string): Promise<void> {
    if (this.acceptedThisBlock >= this.maxPerBlock) return;

    let tx: ethers.TransactionResponse | null;
    try {
      tx = await this.provider.getTransaction(txHash);
    } catch (err) {
      logger.debug("MempoolFilter: getTransaction error", {
        txHash,
        err: String(err),
      });
      return;
    }

    // Guard: tx must be addressed to a known router with enough calldata for a selector
    if (!tx || !tx.to || !tx.data || tx.data.length < 10) return;
    if (!this.routerAddresses.has(tx.to.toLowerCase())) return;

    // First 4 bytes of calldata after the 0x prefix
    const selector = tx.data.slice(2, 10).toLowerCase();
    if (!SWAP_SELECTORS.has(selector)) return;

    const accepted = this.eventStream.publishPendingTx(
      txHash,
      "ws_pending",
      this.maxPerBlock
    );
    if (accepted) {
      this.acceptedThisBlock++;
      logger.debug("MempoolFilter: swap detected", {
        txHash,
        to: tx.to,
        selector,
        gasPrice: tx.gasPrice?.toString(),
      });
    }
  }

  /** Release timers and clear buffers. Call from OpportunityScanner.stop(). */
  destroy(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.seenThisBlock.clear();
    this.pendingBatch.length = 0;
  }
}
