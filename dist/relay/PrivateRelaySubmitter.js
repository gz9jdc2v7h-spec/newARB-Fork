"use strict";
/**
 * PrivateRelaySubmitter — sends a pre-signed raw transaction to a private relay
 * (e.g. Fastlane, Flashbots, MEV Blocker, BloxRoute).
 *
 * The relay expects a JSON-RPC request with method `eth_sendRawTransaction`
 * (or relay-specific variant) and the signed RLP hex as the parameter.
 *
 * This path NEVER falls back to public mempool unless the caller explicitly
 * sets publicFallback = true in the ApexTxRequest.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrivateRelaySubmitter = void 0;
const ethers_1 = require("ethers");
const ReceiptNormalizer_js_1 = require("../receipt/ReceiptNormalizer.js");
/** Relay-provider name → JSON-RPC method (some relays use non-standard names). */
const RELAY_METHODS = {
    flashbots: 'eth_sendBundle', // simplified; real bundles need extra fields
    fastlane: 'eth_sendRawTransaction',
    mevblocker: 'eth_sendRawTransaction',
    bloxroute: 'eth_sendRawTransaction',
    default: 'eth_sendRawTransaction',
};
class PrivateRelaySubmitter {
    endpoint;
    relayName;
    authHeader;
    timeoutMs;
    pollIntervalMs;
    receiptTimeoutMs;
    rpcFallbackUrl;
    constructor(config) {
        this.endpoint = config.endpoint;
        this.relayName = (config.relayName ?? 'default').toLowerCase();
        this.authHeader = config.authHeader;
        this.timeoutMs = config.timeoutMs ?? 10_000;
        this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
        this.receiptTimeoutMs = config.receiptTimeoutMs ?? 120_000;
        this.rpcFallbackUrl = config.rpcFallbackUrl;
    }
    // ── Submit ────────────────────────────────────────────────────────────────────
    async submit(signed, request) {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (this.authHeader) {
            headers['Authorization'] = this.authHeader;
        }
        let relayResponse;
        let relayPayload;
        let submittedBlock = 0;
        try {
            relayPayload = this.buildRelayPayload(signed, request);
            const body = JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: relayPayload.method,
                params: relayPayload.params,
            });
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);
            const res = await fetch(this.endpoint, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
            });
            clearTimeout(timer);
            relayResponse = (await res.json());
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return this.buildFailedResult(signed, request, `Relay request failed: ${errorMsg}`);
        }
        if (relayResponse.error) {
            return this.buildFailedResult(signed, request, `Relay rejected: [${relayResponse.error.code}] ${relayResponse.error.message}`);
        }
        const txHash = relayPayload?.txHash ?? (0, ethers_1.keccak256)(signed.rawTx);
        try {
            submittedBlock = await this.fetchCurrentBlock();
        }
        catch {
            // Non-fatal: block number used for logging only
        }
        return {
            opportunityId: request.opportunityId,
            cycleId: request.cycleId,
            cycleType: request.cycleType,
            submitterAdapter: 'private_relay',
            relay: this.relayName,
            nonce: signed.nonce,
            gasLimit: signed.gasLimit.toString(),
            maxFeePerGas: signed.maxFeePerGas.toString(),
            maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
            submittedBlock,
            expiresAtBlock: request.expiresAtBlock,
            txHash,
            rawTxHash: (0, ethers_1.keccak256)(signed.rawTx),
            payloadHash: request.payloadHash,
            routeHash: request.routeHash,
            stateHash: request.stateHash,
            configHash: request.configHash,
            submissionStatus: 'SUBMITTED_PRIVATE',
            receiptStatus: 'PENDING',
            relayResponse: JSON.stringify(relayResponse),
        };
    }
    // ── Wait for receipt via fallback RPC ─────────────────────────────────────────
    async waitForReceipt(txHash, timeoutMs) {
        const rpcUrl = this.rpcFallbackUrl ?? this.endpoint;
        const deadline = Date.now() + (timeoutMs ?? this.receiptTimeoutMs);
        while (Date.now() < deadline) {
            const raw = await this.rpcGetReceipt(rpcUrl, txHash);
            if (raw) {
                return ReceiptNormalizer_js_1.ReceiptNormalizer.normalize(raw);
            }
            await sleep(this.pollIntervalMs);
        }
        throw new Error(`PrivateRelaySubmitter: receipt timeout for tx ${txHash} after ${timeoutMs ?? this.receiptTimeoutMs}ms`);
    }
    // ── Internal helpers ──────────────────────────────────────────────────────────
    async rpcGetReceipt(rpcUrl, txHash) {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getTransactionReceipt',
                params: [txHash],
            }),
        });
        const json = (await res.json());
        return json.result ?? null;
    }
    async fetchCurrentBlock() {
        const rpcUrl = this.rpcFallbackUrl ?? this.endpoint;
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_blockNumber',
                params: [],
            }),
        });
        const json = (await res.json());
        return parseInt(json.result ?? '0x0', 16);
    }
    buildRelayPayload(signed, request) {
        const method = RELAY_METHODS[this.relayName] ?? RELAY_METHODS['default'];
        const rawTxHash = (0, ethers_1.keccak256)(signed.rawTx);
        if (this.relayName !== 'flashbots') {
            return {
                method,
                params: [signed.rawTx],
                txHash: rawTxHash,
            };
        }
        const targetBlock = request.blockNumber + 1;
        if (request.expiresAtBlock < targetBlock) {
            throw new Error(`Flashbots bundle expires before the next block: expiresAtBlock=${request.expiresAtBlock}, nextBlock=${targetBlock}`);
        }
        return {
            method,
            params: [
                {
                    txs: [signed.rawTx],
                    blockNumber: toRpcQuantity(targetBlock),
                    minTimestamp: Math.floor(Date.now() / 1000),
                    revertingTxHashes: [],
                },
            ],
            txHash: rawTxHash,
        };
    }
    buildFailedResult(signed, request, errorMsg) {
        return {
            opportunityId: request.opportunityId,
            cycleId: request.cycleId,
            cycleType: request.cycleType,
            submitterAdapter: 'private_relay',
            relay: this.relayName,
            nonce: signed.nonce,
            gasLimit: signed.gasLimit.toString(),
            maxFeePerGas: signed.maxFeePerGas.toString(),
            maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
            submittedBlock: 0,
            expiresAtBlock: request.expiresAtBlock,
            txHash: '',
            rawTxHash: (0, ethers_1.keccak256)(signed.rawTx),
            payloadHash: request.payloadHash,
            routeHash: request.routeHash,
            stateHash: request.stateHash,
            configHash: request.configHash,
            submissionStatus: 'FAILED',
            receiptStatus: 'PENDING',
            error: errorMsg,
        };
    }
}
exports.PrivateRelaySubmitter = PrivateRelaySubmitter;
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function toRpcQuantity(value) {
    return `0x${Math.max(0, Math.trunc(value)).toString(16)}`;
}
//# sourceMappingURL=PrivateRelaySubmitter.js.map