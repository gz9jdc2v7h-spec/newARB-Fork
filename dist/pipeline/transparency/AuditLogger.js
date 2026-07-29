"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogger = exports.MultiSink = exports.ConsoleSink = void 0;
exports.buildMinimumEvidence = buildMinimumEvidence;
const ethers_1 = require("ethers");
// ── Console sink (default) ────────────────────────────────────────────────────
class ConsoleSink {
    write(entry) {
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
exports.ConsoleSink = ConsoleSink;
// ── Multi-sink (fan-out) ──────────────────────────────────────────────────────
class MultiSink {
    sinks;
    constructor(sinks) {
        this.sinks = sinks;
    }
    async write(entry) {
        await Promise.all(this.sinks.map((s) => s.write(entry)));
    }
}
exports.MultiSink = MultiSink;
// ── AuditLogger ───────────────────────────────────────────────────────────────
class AuditLogger {
    sink;
    constructor(sink) {
        this.sink = sink ?? new ConsoleSink();
    }
    // ── Stage loggers ─────────────────────────────────────────────────────────
    logConfig(opportunityId, record) {
        this.emit('DISCOVERY', opportunityId, record);
    }
    logState(opportunityId, record) {
        this.emit('QUOTE', opportunityId, record);
    }
    logRoute(opportunityId, record) {
        this.emit('SIZE', opportunityId, record);
    }
    logProfit(opportunityId, record) {
        this.emit('PROFIT_GATE', opportunityId, record);
    }
    logSimulation(opportunityId, record) {
        this.emit('SIMULATION', opportunityId, record);
    }
    logPayload(opportunityId, record) {
        this.emit('PAYLOAD', opportunityId, record);
    }
    logSubmission(opportunityId, result) {
        this.emit('SUBMISSION', opportunityId, result);
    }
    logSettlement(opportunityId, record) {
        this.emit('SETTLEMENT', opportunityId, record);
    }
    logLedger(opportunityId, record) {
        this.emit('LEDGER', opportunityId, record);
    }
    logReceipt(opportunityId, receipt) {
        this.emit('SETTLEMENT', opportunityId, receipt);
    }
    logRejection(record) {
        this.emit(record.stage, record.opportunityId, {
            ...record,
            _type: 'REJECTION',
        });
    }
    /** Full evidence chain — written after all sub-stages complete. */
    logEvidenceChain(chain) {
        this.emit('LEDGER', chain.opportunityId, chain);
    }
    // ── Internal ──────────────────────────────────────────────────────────────
    emit(stage, opportunityId, record) {
        const stageHash = hashRecord(record);
        const entry = {
            timestamp: Date.now(),
            opportunityId,
            stage,
            stageHash,
            record,
        };
        void this.sink.write(entry);
    }
}
exports.AuditLogger = AuditLogger;
// ── Helpers ───────────────────────────────────────────────────────────────────
function hashRecord(record) {
    return (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(JSON.stringify(record)));
}
/**
 * Builds the minimum evidence record required by the ledger invariant.
 * All hash fields are required; missing values default to '0x0'.
 */
function buildMinimumEvidence(chain) {
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
//# sourceMappingURL=AuditLogger.js.map