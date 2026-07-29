/**
 * AuditLogger — writes immutable stage evidence to any sink that implements
 * the LogSink interface (console, file, DB, event-bus, etc.).
 *
 * Every stage in the pipeline calls the appropriate log method.
 * The logger hashes record content to produce a stage-level hash so records
 * can be independently verified.
 *
 * Rules:
 *  - Silent decisions are forbidden.
 *  - Every rejection is logged with the same severity as a win.
 *  - Estimated / Simulated / Realized PnL are never mixed in the same record.
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import type {
  ConfigRecord,
  LedgerRecord,
  NormalizedReceipt,
  OpportunityEvidenceChain,
  PayloadRecord,
  PipelineStage,
  ProfitRecord,
  RejectionRecord,
  RouteRecord,
  SettlementRecord,
  SimulationRecord,
  StateRecord,
  SubmissionResult,
} from '../../types/index.js';

// ── Sink interface ─────────────────────────────────────────────────────────────

export interface LogSink {
  write(entry: AuditEntry): Promise<void> | void;
}

export interface AuditEntry {
  timestamp: number;          // unix ms
  opportunityId: string;
  stage: PipelineStage;
  stageHash: string;          // keccak256 of the JSON record
  record: Record<string, unknown>;
}

// ── Console sink (default) ────────────────────────────────────────────────────

export class ConsoleSink implements LogSink {
  write(entry: AuditEntry): void {
    const line = JSON.stringify({
      t: entry.timestamp,
      opp: entry.opportunityId,
      stage: entry.stage,
      hash: entry.stageHash,
      ...entry.record,
    });
    process.stdout.write(line + '\n');
  }
}

// ── Multi-sink (fan-out) ──────────────────────────────────────────────────────

export class MultiSink implements LogSink {
  constructor(private readonly sinks: LogSink[]) {}
  async write(entry: AuditEntry): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.write(entry)));
  }
}

// ── AuditLogger ───────────────────────────────────────────────────────────────

export class AuditLogger {
  private readonly sink: LogSink;

  constructor(sink?: LogSink) {
    this.sink = sink ?? new ConsoleSink();
  }

  // ── Stage loggers ─────────────────────────────────────────────────────────

  logConfig(opportunityId: string, record: ConfigRecord): void {
    this.emit('DISCOVERY', opportunityId, record as unknown as Record<string, unknown>);
  }

  logState(opportunityId: string, record: StateRecord): void {
    this.emit('QUOTE', opportunityId, record as unknown as Record<string, unknown>);
  }

  logRoute(opportunityId: string, record: RouteRecord): void {
    this.emit('SIZE', opportunityId, record as unknown as Record<string, unknown>);
  }

  logProfit(opportunityId: string, record: ProfitRecord): void {
    this.emit('PROFIT_GATE', opportunityId, record as unknown as Record<string, unknown>);
  }

  logSimulation(opportunityId: string, record: SimulationRecord): void {
    this.emit('SIMULATION', opportunityId, record as unknown as Record<string, unknown>);
  }

  logPayload(opportunityId: string, record: PayloadRecord): void {
    this.emit('PAYLOAD', opportunityId, record as unknown as Record<string, unknown>);
  }

  logSubmission(opportunityId: string, result: SubmissionResult): void {
    this.emit('SUBMISSION', opportunityId, result as unknown as Record<string, unknown>);
  }

  logSettlement(opportunityId: string, record: SettlementRecord): void {
    this.emit('SETTLEMENT', opportunityId, record as unknown as Record<string, unknown>);
  }

  logLedger(opportunityId: string, record: LedgerRecord): void {
    this.emit('LEDGER', opportunityId, record as unknown as Record<string, unknown>);
  }

  logReceipt(opportunityId: string, receipt: NormalizedReceipt): void {
    this.emit('SETTLEMENT', opportunityId, receipt as unknown as Record<string, unknown>);
  }

  logRejection(record: RejectionRecord): void {
    this.emit(record.stage, record.opportunityId, {
      ...record as unknown as Record<string, unknown>,
      _type: 'REJECTION',
    });
  }

  /** Full evidence chain — written after all sub-stages complete. */
  logEvidenceChain(chain: OpportunityEvidenceChain): void {
    this.emit(
      'LEDGER',
      chain.opportunityId,
      chain as unknown as Record<string, unknown>,
    );
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private emit(
    stage: PipelineStage,
    opportunityId: string,
    record: Record<string, unknown>,
  ): void {
    const stageHash = hashRecord(record);
    const entry: AuditEntry = {
      timestamp: Date.now(),
      opportunityId,
      stage,
      stageHash,
      record,
    };
    void this.sink.write(entry);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hashRecord(record: Record<string, unknown>): string {
  return keccak256(toUtf8Bytes(JSON.stringify(record)));
}

/**
 * Builds the minimum evidence record required by the ledger invariant.
 * All hash fields are required; missing values default to '0x0'.
 */
export function buildMinimumEvidence(
  chain: Partial<OpportunityEvidenceChain> & { opportunityId: string },
): Record<string, unknown> {
  return {
    opportunity_id: chain.opportunityId,
    config_version: chain.configVersion ?? 0,
    config_hash: chain.configHash ?? '0x0',
    state_hash: chain.stateHash ?? '0x0',
    route_hash: chain.routeHash ?? '0x0',
    simulation_hash: chain.simulationHash ?? '0x0',
    payload_hash: chain.payloadHash ?? '0x0',
    tx_hash: chain.txHash ?? '0x0',
    settlement_status: chain.settlementStatus ?? 'PENDING',
    realized_net_usd: chain.realizedNetUsd ?? '0.00',
  };
}
