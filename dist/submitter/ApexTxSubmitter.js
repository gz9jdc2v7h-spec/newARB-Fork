"use strict";
/**
 * ApexTxSubmitter — the single controlled transaction gateway.
 *
 * This is the only implementation of TxSubmitter that the rest of the machine
 * (scanner, route engine, C1, C2) should ever instantiate.
 *
 * Pipeline:
 *   build()  → validate payload structure
 *   sign()   → nonce acquire + EIP-1559 signing (ethers v6)
 *   submit() → private relay first; public fallback only if explicitly allowed
 *   wait()   → poll until confirmed, reverted, or expired; normalize receipt
 *
 * Every call path emits a LedgerRecord via the AuditLogger.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApexTxSubmitter = void 0;
const ethers_1 = require("ethers");
const NonceManager_js_1 = require("../nonce/NonceManager.js");
const EthersV6Adapter_js_1 = require("../adapters/EthersV6Adapter.js");
const PrivateRelaySubmitter_js_1 = require("../relay/PrivateRelaySubmitter.js");
const AuditLogger_js_1 = require("../pipeline/transparency/AuditLogger.js");
class ApexTxSubmitter {
    provider;
    nonceManager;
    ethersAdapter;
    relaySubmitter;
    logger;
    receiptTimeoutMs;
    constructor(config) {
        this.provider = new ethers_1.JsonRpcProvider(config.rpcUrl);
        this.nonceManager = new NonceManager_js_1.NonceManager(this.provider);
        this.receiptTimeoutMs = config.receiptTimeoutMs ?? 120_000;
        this.logger = config.logger ?? new AuditLogger_js_1.AuditLogger();
        this.ethersAdapter = new EthersV6Adapter_js_1.EthersV6Adapter({
            provider: this.provider,
            nonceManager: this.nonceManager,
            chainId: config.chainId,
            pollIntervalMs: config.pollIntervalMs,
            receiptTimeoutMs: config.receiptTimeoutMs,
        });
        if (config.relay) {
            this.relaySubmitter = new PrivateRelaySubmitter_js_1.PrivateRelaySubmitter({
                endpoint: config.relay.endpoint,
                relayName: config.relay.relayName,
                authHeader: config.relay.authHeader,
                timeoutMs: config.relay.timeoutMs,
                pollIntervalMs: config.pollIntervalMs,
                receiptTimeoutMs: config.receiptTimeoutMs,
                rpcFallbackUrl: config.rpcUrl,
            });
        }
    }
    // ── TxSubmitter interface ─────────────────────────────────────────────────
    async build(request) {
        return this.ethersAdapter.build(request);
    }
    async sign(request) {
        return this.ethersAdapter.sign(request);
    }
    async submit(signed) {
        // We need the originating request to determine relay policy.
        // submit() receives a SignedTx, so relay policy was baked in at sign() time.
        // Callers should use submitWithRequest() for relay-aware submission.
        // This overload assumes public submission (used by tests / dry-run).
        throw new Error('ApexTxSubmitter: call submitWithRequest(signed, request) instead of submit(signed). ' +
            'Relay policy requires the original ApexTxRequest.');
    }
    /**
     * Full submit: private relay first (if configured), public fallback only if
     * the request explicitly allows it.
     *
     * This is the method C1 and C2 engines MUST use.
     */
    async submitWithRequest(signed, request) {
        let result;
        if (request.privateRelayFirst && this.relaySubmitter) {
            result = await this.relaySubmitter.submit(signed, request);
            if (result.submissionStatus === 'FAILED' && request.publicFallback) {
                // Relay failed — fall back to public RPC
                result = await this.ethersAdapter.submitPublic(signed, request);
            }
        }
        else if (request.publicFallback) {
            result = await this.ethersAdapter.submitPublic(signed, request);
        }
        else {
            // Neither relay configured nor public fallback allowed
            result = {
                ...this.buildBaseResult(signed, request),
                submissionStatus: 'FAILED',
                receiptStatus: 'PENDING',
                error: 'No relay configured and public fallback is disabled',
            };
        }
        this.emitLedgerRecord(result, request);
        return result;
    }
    async wait(txHash, timeoutMs) {
        const timeout = timeoutMs ?? this.receiptTimeoutMs;
        // Try relay receipt poller first (it already knows the fallback RPC)
        if (this.relaySubmitter) {
            return this.relaySubmitter.waitForReceipt(txHash, timeout);
        }
        return this.ethersAdapter.waitForReceipt(txHash, timeout);
    }
    // ── Internal ──────────────────────────────────────────────────────────────
    emitLedgerRecord(result, request) {
        const ledger = {
            opportunityId: request.opportunityId,
            cycleType: request.cycleType,
            cycleId: request.cycleId,
            submitterAdapter: result.submitterAdapter,
            nonce: result.nonce,
            rawTxHash: result.rawTxHash,
            txHash: result.txHash,
            payloadHash: result.payloadHash,
            routeHash: result.routeHash,
            stateHash: result.stateHash,
            configHash: result.configHash,
            configVersion: request.configVersion,
            submissionStatus: result.submissionStatus,
            receiptStatus: result.receiptStatus,
        };
        this.logger.logLedger(request.opportunityId, ledger);
    }
    buildBaseResult(signed, request) {
        return {
            opportunityId: request.opportunityId,
            cycleId: request.cycleId,
            cycleType: request.cycleType,
            submitterAdapter: 'ethers_v6',
            nonce: signed.nonce,
            gasLimit: signed.gasLimit.toString(),
            maxFeePerGas: signed.maxFeePerGas.toString(),
            maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
            submittedBlock: 0,
            expiresAtBlock: request.expiresAtBlock,
            txHash: '',
            rawTxHash: '',
            payloadHash: request.payloadHash,
            routeHash: request.routeHash,
            stateHash: request.stateHash,
            configHash: request.configHash,
        };
    }
}
exports.ApexTxSubmitter = ApexTxSubmitter;
//# sourceMappingURL=ApexTxSubmitter.js.map