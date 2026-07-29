"use strict";
/**
 * C1Engine — hooks for the C1 (first-cycle) flash-loan arbitrage path.
 *
 * This module is NOT the arbitrage brain. It is the controlled interface
 * between opportunity_engine → payload_builder → apex-tx-submitter for C1.
 *
 * Flow:
 *   1. Verify pre-conditions (config, state freshness, kill switch)
 *   2. Encode initAaveFlash / initBalancerFlash calldata
 *   3. Request nonce from central NonceManager
 *   4. sign() → submit() via TxSubmitter (private relay first)
 *   5. wait() for NormalizedReceipt
 *   6. Write c1_cycle settlement record to ledger
 *   7. Emit LedgerRecord
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.C1Engine = exports.C1_SELECTORS = void 0;
const ethers_1 = require("ethers");
const EvidenceChain_js_1 = require("../transparency/EvidenceChain.js");
const AuditLogger_js_1 = require("../transparency/AuditLogger.js");
const C1_FUNCTIONS = {
    aave: 'initAaveFlash',
    balancer: 'initBalancerFlash',
};
const C1_INTERFACE = new ethers_1.Interface([
    'function initAaveFlash(address,uint256,bytes)',
    'function initBalancerFlash(address,uint256,bytes)',
]);
const AAVE_SELECTOR = getRequiredSelector(C1_FUNCTIONS.aave);
const BALANCER_SELECTOR = getRequiredSelector(C1_FUNCTIONS.balancer);
exports.C1_SELECTORS = {
    aave: AAVE_SELECTOR,
    balancer: BALANCER_SELECTOR,
};
// ── C1Engine ──────────────────────────────────────────────────────────────────
class C1Engine {
    submitter;
    logger;
    constructor(submitter, logger) {
        this.submitter = submitter;
        this.logger = logger ?? new AuditLogger_js_1.AuditLogger();
    }
    async execute(req) {
        const chain = new EvidenceChain_js_1.EvidenceChain(req.opportunityId, req.config.configVersion, req.config.configHash);
        chain.setConfig(req.config);
        chain.setState(req.state);
        chain.setRoute(req.route);
        chain.setC1({
            cycleId: req.cycleId,
            preC1StateHash: req.stateHash,
            c1RouteHash: req.route.routeHash,
            c1SimHash: req.simulationHash,
        });
        // 1. Build calldata
        const calldata = encodeC1Calldata(req);
        const routeHash = (0, ethers_1.keccak256)((0, ethers_1.toUtf8Bytes)(JSON.stringify(req.route)));
        // 2. Build ApexTxRequest
        const txRequest = {
            opportunityId: req.opportunityId,
            cycleType: 'C1',
            cycleId: req.cycleId,
            chainId: req.state.chainId,
            blockNumber: req.state.blockNumber,
            signerPrivateKey: req.signerPrivateKey,
            gasLimit: req.gasLimit,
            maxFeePerGas: req.maxFeePerGas,
            maxPriorityFeePerGas: req.maxPriorityFeePerGas,
            to: req.executor,
            data: calldata,
            opportunityHash: req.opportunityHash,
            payloadHash: req.payloadHash,
            routeHash,
            stateHash: req.stateHash,
            configHash: req.config.configHash,
            configVersion: req.config.configVersion,
            privateRelayFirst: true,
            publicFallback: req.publicFallback,
            relayEndpoint: req.relayEndpoint,
            expiresAtBlock: req.expiresAtBlock,
        };
        // 3. Sign
        const signed = await this.submitter.sign(txRequest);
        // 4. Submit (via TxSubmitter — never ethers/web3 directly)
        const submission = await this.submitter.submit(signed);
        this.logger.logSubmission(req.opportunityId, submission);
        chain.setSubmission(submission);
        // 5. Wait for receipt
        const receipt = await this.submitter.wait(submission.txHash);
        this.logger.logReceipt(req.opportunityId, receipt);
        // 6. Build ledger record
        const ledgerRecord = {
            opportunityId: req.opportunityId,
            cycleType: 'C1',
            cycleId: req.cycleId,
            submitterAdapter: submission.submitterAdapter,
            nonce: submission.nonce,
            rawTxHash: submission.rawTxHash,
            txHash: submission.txHash,
            payloadHash: req.payloadHash,
            routeHash,
            stateHash: req.stateHash,
            configHash: req.config.configHash,
            configVersion: req.config.configVersion,
            submissionStatus: submission.submissionStatus,
            receiptStatus: receipt.receiptStatus ? 'CONFIRMED' : 'REVERTED',
            settledAt: Date.now(),
        };
        this.logger.logLedger(req.opportunityId, ledgerRecord);
        chain.setC1({
            cycleId: req.cycleId,
            preC1StateHash: req.stateHash,
            c1RouteHash: routeHash,
            c1SimHash: req.simulationHash,
            c1TxHash: submission.txHash,
        });
        return { cycleId: req.cycleId, submission, receipt, ledgerRecord, evidenceChain: chain };
    }
}
exports.C1Engine = C1Engine;
// ── ABI encoding helpers ──────────────────────────────────────────────────────
function encodeC1Calldata(req) {
    return C1_INTERFACE.encodeFunctionData(C1_FUNCTIONS[req.flashProvider], [req.borrowAsset, req.borrowAmount, req.encodedRoutePayload]);
}
function getRequiredSelector(name) {
    const fragment = C1_INTERFACE.getFunction(name);
    if (!fragment) {
        throw new Error(`C1Engine: missing ABI fragment for ${name}`);
    }
    return fragment.selector;
}
//# sourceMappingURL=C1Engine.js.map