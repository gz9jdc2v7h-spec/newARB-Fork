"use strict";
/**
 * C2Engine — hooks for the C2 (second-cycle) MIRROR / REVERSE / NO_OP path.
 *
 * C2 INVARIANTS:
 *  1. C2 NEVER submits before the parent C1 receipt is confirmed.
 *  2. Post-C1 state is always reloaded before C2 sizing.
 *  3. C2 is only valid in blocks N+1 to N+5 relative to C1 confirmation.
 *  4. C2 profit is written separately — never merged with C1.
 *  5. NO_OP is a valid and explicitly logged outcome.
 *
 * Flow:
 *   1. Assert parent C1 is CONFIRMED (receiptStatus === true)
 *   2. Reload post-C1 pool state
 *   3. Evaluate MIRROR / REVERSE / NO_OP
 *   4. If NO_OP → log and return
 *   5. Request fresh nonce
 *   6. sign() → submit() via TxSubmitter
 *   7. wait() for NormalizedReceipt
 *   8. Write c2_cycle settlement record
 *   9. Emit LedgerRecord
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.C2Engine = void 0;
exports.selectC2Decision = selectC2Decision;
const ethers_1 = require("ethers");
const EvidenceChain_js_1 = require("../transparency/EvidenceChain.js");
const AuditLogger_js_1 = require("../transparency/AuditLogger.js");
// ── C2Engine ──────────────────────────────────────────────────────────────────
class C2Engine {
    submitter;
    logger;
    constructor(submitter, logger) {
        this.submitter = submitter;
        this.logger = logger ?? new AuditLogger_js_1.AuditLogger();
    }
    async execute(req) {
        const chain = new EvidenceChain_js_1.EvidenceChain(req.opportunityId, req.config.configVersion, req.config.configHash);
        chain.setConfig(req.config);
        chain.setState(req.postC1State);
        const postC1StateHash = req.postC1State.stateHash;
        const { decision, selectedCandidate } = selectC2Decision(req.mirrorCandidate, req.reverseCandidate, Number(req.config.minNetProfitUsd));
        const c2RouteHash = selectedCandidate
            ? (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(JSON.stringify(selectedCandidate.route)))
            : undefined;
        if (selectedCandidate) {
            chain.setRoute(selectedCandidate.route);
        }
        chain.setC2({
            cycleId: req.cycleId,
            parentC1TxHash: req.parentC1TxHash,
            postC1StateHash,
            c2Decision: decision,
            c2MirrorNetProfitUsd: req.mirrorCandidate?.netProfitUsd,
            c2ReverseNetProfitUsd: req.reverseCandidate?.netProfitUsd,
            c2MirrorGatesPassed: req.mirrorCandidate?.allGatesPassed ?? false,
            c2ReverseGatesPassed: req.reverseCandidate?.allGatesPassed ?? false,
            c2RouteHash,
            c2SimHash: req.simulationHash,
        });
        if (req.c1StateHash !== req.reloadedFromC1StateHash) {
            this.logger.logRejection({
                opportunityId: req.opportunityId,
                stage: 'SUBMISSION',
                status: 'REJECTED',
                reason: 'C2_STATE_RELOAD_MISMATCH',
                configVersion: req.config.configVersion,
                stateHash: postC1StateHash,
                detail: `Expected reload marker ${req.c1StateHash}, got ${req.reloadedFromC1StateHash}`,
                timestamp: Date.now(),
            });
            return {
                cycleId: req.cycleId,
                decision,
                skipped: true,
                evidenceChain: chain,
            };
        }
        // ── Invariant 1: Parent C1 must be confirmed ───────────────────────────────
        if (!req.parentC1ReceiptStatus) {
            this.logger.logRejection({
                opportunityId: req.opportunityId,
                stage: 'SUBMISSION',
                status: 'REJECTED',
                reason: 'C2_PARENT_NOT_CONFIRMED',
                configVersion: req.config.configVersion,
                stateHash: postC1StateHash,
                routeHash: c2RouteHash ?? '0x0',
                detail: `Parent C1 tx ${req.parentC1TxHash} did not confirm`,
                timestamp: Date.now(),
            });
            return {
                cycleId: req.cycleId,
                decision,
                skipped: true,
                evidenceChain: chain,
            };
        }
        // ── Invariant 2: Must be within block window ────────────────────────────────
        const maxOffset = req.maxBlockOffset ?? 5;
        const currentBlock = req.postC1State.blockNumber;
        const offsetFromC1 = currentBlock - req.parentC1ConfirmedBlock;
        if (offsetFromC1 < 1 || offsetFromC1 > maxOffset) {
            this.logger.logRejection({
                opportunityId: req.opportunityId,
                stage: 'SUBMISSION',
                status: 'REJECTED',
                reason: 'STATE_TOO_OLD',
                configVersion: req.config.configVersion,
                stateHash: postC1StateHash,
                detail: `C2 block offset ${offsetFromC1} outside [1, ${maxOffset}]`,
                timestamp: Date.now(),
            });
            return {
                cycleId: req.cycleId,
                decision,
                skipped: true,
                evidenceChain: chain,
            };
        }
        if (hasDynamicReuse(req.mirrorCandidate?.reuseGuard) ||
            hasDynamicReuse(req.reverseCandidate?.reuseGuard)) {
            this.logger.logRejection({
                opportunityId: req.opportunityId,
                stage: 'SUBMISSION',
                status: 'REJECTED',
                reason: 'C2_DYNAMIC_REUSE_DETECTED',
                configVersion: req.config.configVersion,
                stateHash: postC1StateHash,
                routeHash: c2RouteHash ?? '0x0',
                detail: 'Rejected due to C1 dynamic artifact reuse attempt',
                timestamp: Date.now(),
            });
            return {
                cycleId: req.cycleId,
                decision,
                skipped: true,
                evidenceChain: chain,
            };
        }
        // ── Invariant 3: NO_OP is valid — log and return ───────────────────────────
        if (decision === 'NO_OP' || !selectedCandidate) {
            this.logger.logRejection({
                opportunityId: req.opportunityId,
                stage: 'PROFIT_GATE',
                status: 'REJECTED',
                reason: 'NET_PROFIT_BELOW_MINIMUM',
                configVersion: req.config.configVersion,
                stateHash: postC1StateHash,
                routeHash: c2RouteHash ?? '0x0',
                detail: 'C2 decision: NO_OP — no profitable continuation found',
                timestamp: Date.now(),
            });
            return {
                cycleId: req.cycleId,
                decision: 'NO_OP',
                skipped: true,
                evidenceChain: chain,
            };
        }
        if (!c2RouteHash) {
            this.logger.logRejection({
                opportunityId: req.opportunityId,
                stage: 'SUBMISSION',
                status: 'REJECTED',
                reason: 'PAYLOAD_ABI_MISMATCH',
                configVersion: req.config.configVersion,
                stateHash: postC1StateHash,
                detail: 'Selected candidate missing route hash',
                timestamp: Date.now(),
            });
            return {
                cycleId: req.cycleId,
                decision,
                skipped: true,
                evidenceChain: chain,
            };
        }
        // ── Execute C2 ─────────────────────────────────────────────────────────────
        const txRequest = {
            opportunityId: req.opportunityId,
            cycleType: 'C2',
            cycleId: req.cycleId,
            chainId: req.postC1State.chainId,
            blockNumber: req.postC1State.blockNumber,
            signerPrivateKey: req.signerPrivateKey,
            gasLimit: req.gasLimit,
            maxFeePerGas: req.maxFeePerGas,
            maxPriorityFeePerGas: req.maxPriorityFeePerGas,
            to: req.executor,
            data: selectedCandidate.encodedRoutePayload,
            opportunityHash: req.opportunityHash,
            payloadHash: req.payloadHash,
            routeHash: c2RouteHash,
            stateHash: postC1StateHash,
            configHash: req.config.configHash,
            configVersion: req.config.configVersion,
            privateRelayFirst: true,
            publicFallback: req.publicFallback,
            relayEndpoint: req.relayEndpoint,
            expiresAtBlock: req.expiresAtBlock,
        };
        const signed = await this.submitter.sign(txRequest);
        const submission = await this.submitter.submit(signed);
        this.logger.logSubmission(req.opportunityId, submission);
        chain.setSubmission(submission);
        const receipt = await this.submitter.wait(submission.txHash);
        this.logger.logReceipt(req.opportunityId, receipt);
        const ledgerRecord = {
            opportunityId: req.opportunityId,
            cycleType: 'C2',
            cycleId: req.cycleId,
            submitterAdapter: submission.submitterAdapter,
            nonce: submission.nonce,
            rawTxHash: submission.rawTxHash,
            txHash: submission.txHash,
            payloadHash: req.payloadHash,
            routeHash: c2RouteHash,
            stateHash: postC1StateHash,
            configHash: req.config.configHash,
            configVersion: req.config.configVersion,
            submissionStatus: submission.submissionStatus,
            receiptStatus: receipt.receiptStatus ? 'CONFIRMED' : 'REVERTED',
            settledAt: Date.now(),
        };
        this.logger.logLedger(req.opportunityId, ledgerRecord);
        chain.setC2({
            cycleId: req.cycleId,
            parentC1TxHash: req.parentC1TxHash,
            postC1StateHash,
            c2Decision: decision,
            c2MirrorNetProfitUsd: req.mirrorCandidate?.netProfitUsd,
            c2ReverseNetProfitUsd: req.reverseCandidate?.netProfitUsd,
            c2MirrorGatesPassed: req.mirrorCandidate?.allGatesPassed ?? false,
            c2ReverseGatesPassed: req.reverseCandidate?.allGatesPassed ?? false,
            c2RouteHash,
            c2SimHash: req.simulationHash,
            c2TxHash: submission.txHash,
        });
        return {
            cycleId: req.cycleId,
            decision,
            skipped: false,
            submission,
            receipt,
            ledgerRecord,
            evidenceChain: chain,
        };
    }
}
exports.C2Engine = C2Engine;
function selectC2Decision(mirrorCandidate, reverseCandidate, minNetProfitUsd) {
    const mirrorNet = parseProfit(mirrorCandidate?.netProfitUsd);
    const reverseNet = parseProfit(reverseCandidate?.netProfitUsd);
    const mirrorValid = !!mirrorCandidate?.allGatesPassed && mirrorNet !== null;
    const reverseValid = !!reverseCandidate?.allGatesPassed && reverseNet !== null;
    if (mirrorCandidate &&
        mirrorValid &&
        mirrorNet !== null &&
        mirrorNet >= minNetProfitUsd &&
        mirrorNet >= (reverseNet ?? Number.NEGATIVE_INFINITY)) {
        return { decision: 'MIRROR', selectedCandidate: mirrorCandidate };
    }
    if (reverseCandidate &&
        reverseValid &&
        reverseNet !== null &&
        reverseNet >= minNetProfitUsd &&
        reverseNet > (mirrorNet ?? Number.NEGATIVE_INFINITY)) {
        return { decision: 'REVERSE', selectedCandidate: reverseCandidate };
    }
    return { decision: 'NO_OP' };
}
function parseProfit(value) {
    if (!value)
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function hasDynamicReuse(guard) {
    if (!guard)
        return false;
    return Object.values(guard).some(Boolean);
}
//# sourceMappingURL=C2Engine.js.map