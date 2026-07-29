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
import type { ConfigRecord, LedgerRecord, NormalizedReceipt, OpportunityEvidenceChain, PayloadRecord, PipelineStage, ProfitRecord, RejectionRecord, RouteRecord, SettlementRecord, SimulationRecord, StateRecord, SubmissionResult } from '../../types/index.js';
export interface LogSink {
    write(entry: AuditEntry): Promise<void> | void;
}
export interface AuditEntry {
    timestamp: number;
    opportunityId: string;
    stage: PipelineStage;
    stageHash: string;
    record: Record<string, unknown>;
}
export declare class ConsoleSink implements LogSink {
    write(entry: AuditEntry): void;
}
export declare class MultiSink implements LogSink {
    private readonly sinks;
    constructor(sinks: LogSink[]);
    write(entry: AuditEntry): Promise<void>;
}
export declare class AuditLogger {
    private readonly sink;
    constructor(sink?: LogSink);
    logConfig(opportunityId: string, record: ConfigRecord): void;
    logState(opportunityId: string, record: StateRecord): void;
    logRoute(opportunityId: string, record: RouteRecord): void;
    logProfit(opportunityId: string, record: ProfitRecord): void;
    logSimulation(opportunityId: string, record: SimulationRecord): void;
    logPayload(opportunityId: string, record: PayloadRecord): void;
    logSubmission(opportunityId: string, result: SubmissionResult): void;
    logSettlement(opportunityId: string, record: SettlementRecord): void;
    logLedger(opportunityId: string, record: LedgerRecord): void;
    logReceipt(opportunityId: string, receipt: NormalizedReceipt): void;
    logRejection(record: RejectionRecord): void;
    /** Full evidence chain — written after all sub-stages complete. */
    logEvidenceChain(chain: OpportunityEvidenceChain): void;
    private emit;
}
/**
 * Builds the minimum evidence record required by the ledger invariant.
 * All hash fields are required; missing values default to '0x0'.
 */
export declare function buildMinimumEvidence(chain: Partial<OpportunityEvidenceChain> & {
    opportunityId: string;
}): Record<string, unknown>;
//# sourceMappingURL=AuditLogger.d.ts.map