import { REPRICE_FEE_BUMP_BPS, REPRICE_MAX_ATTEMPTS, REPRICE_TIMEOUT_MS } from "../config";
import { RuntimeEventStream } from "./RuntimeEventStream";

export interface PendingExecutionState {
  opportunityId: string;
  txHash: string;
  attempts: number;
  submittedAtMs: number;
  maxAttempts: number;
  feeBumpBps: number;
  timeoutMs: number;
}

export class MempoolRepricingManager {
  private readonly states = new Map<string, PendingExecutionState>();

  constructor(private readonly eventStream?: RuntimeEventStream) {}

  registerSubmission(opportunityId: string, txHash: string): PendingExecutionState {
    const state: PendingExecutionState = {
      opportunityId,
      txHash,
      attempts: 1,
      submittedAtMs: Date.now(),
      maxAttempts: REPRICE_MAX_ATTEMPTS,
      feeBumpBps: REPRICE_FEE_BUMP_BPS,
      timeoutMs: REPRICE_TIMEOUT_MS,
    };
    this.states.set(opportunityId, state);
    this.eventStream?.publishExecutionStatus({
      source: "submitter",
      opportunityId,
      mode: "mempool",
      status: "submitted",
      detail: txHash,
    });
    return state;
  }

  markReplaced(opportunityId: string, replacementTxHash: string): void {
    const state = this.states.get(opportunityId);
    if (!state) return;
    state.attempts += 1;
    state.txHash = replacementTxHash;
    this.eventStream?.publishExecutionStatus({
      source: "submitter",
      opportunityId,
      mode: "mempool",
      status: "replaced",
      detail: replacementTxHash,
    });
  }

  markCancelled(opportunityId: string, reason: string): void {
    this.states.delete(opportunityId);
    this.eventStream?.publishExecutionStatus({
      source: "risk",
      opportunityId,
      mode: "mempool",
      status: "cancelled",
      detail: reason,
    });
  }

  markConfirmed(opportunityId: string, txHash: string): void {
    this.states.delete(opportunityId);
    this.eventStream?.publishExecutionStatus({
      source: "executor",
      opportunityId,
      mode: "mempool",
      status: "confirmed",
      detail: txHash,
    });
  }

  markReverted(opportunityId: string, txHash: string): void {
    this.states.delete(opportunityId);
    this.eventStream?.publishExecutionStatus({
      source: "executor",
      opportunityId,
      mode: "mempool",
      status: "reverted",
      detail: txHash,
    });
  }

  evaluateTimeouts(nowMs = Date.now()): PendingExecutionState[] {
    const expired: PendingExecutionState[] = [];
    for (const [opportunityId, state] of this.states.entries()) {
      if (nowMs - state.submittedAtMs <= state.timeoutMs) continue;
      expired.push(state);
      this.states.delete(opportunityId);
      this.eventStream?.publishExecutionStatus({
        source: "risk",
        opportunityId,
        mode: "mempool",
        status: "expired",
        detail: `timeout_ms=${state.timeoutMs}`,
      });
    }
    return expired;
  }

  shouldAttemptReplacement(opportunityId: string): boolean {
    const state = this.states.get(opportunityId);
    if (!state) return false;
    return state.attempts < state.maxAttempts;
  }

  snapshot(): PendingExecutionState[] {
    return Array.from(this.states.values()).map((s) => ({ ...s }));
  }
}
