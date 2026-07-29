import { EventEmitter } from "events";
import { MARKET_EVENT_BUFFER_SIZE } from "../config";
import type { PairQuotes } from "../discovery/OpportunityScanner";
import type { NormalizedReceipt } from "../types";

export type RuntimeEventSource =
  | "http_poll"
  | "ws_block"
  | "ws_pending"
  | "scanner"
  | "executor"
  | "submitter"
  | "risk";

export interface RuntimeEventBase {
  kind: RuntimeEventKind;
  source: RuntimeEventSource;
  observedAtMs: number;
}

export interface BlockRuntimeEvent extends RuntimeEventBase {
  kind: "block";
  blockNumber: number;
}

export interface PendingTxRuntimeEvent extends RuntimeEventBase {
  kind: "pending_tx";
  txHash: string;
}

export interface PoolUpdateRuntimeEvent extends RuntimeEventBase {
  kind: "pool_update";
  pairCount: number;
  quoteCount: number;
  pairs: Array<{ pair: string; dexes: string[]; invariantFamilies: string[] }>;
}

export interface ReceiptRuntimeEvent extends RuntimeEventBase {
  kind: "receipt";
  txHash: string;
  receiptStatus: boolean;
  confirmedBlock: number;
  gasUsed: string;
}

export interface HealthRuntimeEvent extends RuntimeEventBase {
  kind: "health";
  channel: "ws" | "http" | "execution" | "risk";
  status: "ok" | "degraded" | "paused";
  detail: string;
}

export type RuntimeEventKind =
  | "block"
  | "pending_tx"
  | "pool_update"
  | "receipt"
  | "health";

export type RuntimeEvent =
  | BlockRuntimeEvent
  | PendingTxRuntimeEvent
  | PoolUpdateRuntimeEvent
  | ReceiptRuntimeEvent
  | HealthRuntimeEvent;

export class RuntimeEventStream {
  private readonly emitter = new EventEmitter();
  private readonly history: RuntimeEvent[] = [];
  private readonly maxHistory: number;
  private pendingSeenThisBlock = 0;
  private lastBlockNumber: number | null = null;

  constructor(maxHistory = MARKET_EVENT_BUFFER_SIZE) {
    this.maxHistory = Math.max(32, maxHistory);
  }

  on(listener: (event: RuntimeEvent) => void): void {
    this.emitter.on("event", listener);
  }

  off(listener: (event: RuntimeEvent) => void): void {
    this.emitter.off("event", listener);
  }

  publishBlock(blockNumber: number, source: RuntimeEventSource): void {
    if (this.lastBlockNumber !== blockNumber) {
      this.lastBlockNumber = blockNumber;
      this.pendingSeenThisBlock = 0;
    }
    this.publish({
      kind: "block",
      source,
      observedAtMs: Date.now(),
      blockNumber,
    });
  }

  publishPendingTx(txHash: string, source: RuntimeEventSource, maxPerBlock: number): boolean {
    if (this.pendingSeenThisBlock >= maxPerBlock) {
      return false;
    }
    this.pendingSeenThisBlock += 1;
    this.publish({
      kind: "pending_tx",
      source,
      observedAtMs: Date.now(),
      txHash,
    });
    return true;
  }

  publishPoolUpdate(snapshot: PairQuotes[], source: RuntimeEventSource): void {
    this.publish({
      kind: "pool_update",
      source,
      observedAtMs: Date.now(),
      pairCount: snapshot.length,
      quoteCount: snapshot.reduce((sum, pair) => sum + pair.quotes.length, 0),
      pairs: snapshot.map((pair) => ({
        pair: `${pair.tokenIn}/${pair.tokenOut}`,
        dexes: pair.quotes.map((quote) => quote.dex),
        invariantFamilies: Array.from(
          new Set(pair.quotes.map((quote) => quote.invariantFamily))
        ),
      })),
    });
  }

  publishReceipt(receipt: NormalizedReceipt | ReceiptRuntimeEvent, source?: RuntimeEventSource): void {
    if ("kind" in receipt) {
      this.publish(receipt);
      return;
    }
    this.publish({
      kind: "receipt",
      source: source ?? "submitter",
      observedAtMs: Date.now(),
      txHash: receipt.txHash,
      receiptStatus: receipt.receiptStatus,
      confirmedBlock: receipt.confirmedBlock,
      gasUsed: receipt.gasUsed,
    });
  }

  publishHealth(
    channel: HealthRuntimeEvent["channel"],
    status: HealthRuntimeEvent["status"],
    detail: string,
    source: RuntimeEventSource
  ): void {
    this.publish({
      kind: "health",
      source,
      observedAtMs: Date.now(),
      channel,
      status,
      detail,
    });
  }

  snapshot(): RuntimeEvent[] {
    return [...this.history];
  }

  private publish(event: RuntimeEvent): void {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
    this.emitter.emit("event", event);
  }
}
