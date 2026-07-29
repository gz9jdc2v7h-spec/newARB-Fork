/**
 * Web3Adapter — optional web3.js signing/submission adapter.
 *
 * Produces an identical SignedTx and SubmissionResult shape to EthersV6Adapter
 * so the rest of the pipeline is adapter-agnostic.
 *
 * This module is optional: if web3 is not installed the adapter can still be
 * imported but any call to sign() or submitPublic() will throw with a clear
 * "web3 not installed" message rather than a cryptic module error.
 */
import { keccak256 } from 'ethers';
import { ReceiptNormalizer } from '../receipt/ReceiptNormalizer.js';
// Lazy-load web3 so a missing package gives a helpful error at call time.
let web3Module;
async function getWeb3() {
    if (web3Module)
        return web3Module;
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        web3Module = await import('web3');
        return web3Module;
    }
    catch {
        throw new Error('Web3Adapter: web3 package is not installed. ' +
            'Run `npm install web3` or use the EthersV6Adapter instead.');
    }
}
export class Web3Adapter {
    rpcUrl;
    nonceManager;
    chainId;
    pollIntervalMs;
    receiptTimeoutMs;
    constructor(config) {
        this.rpcUrl = config.rpcUrl;
        this.nonceManager = config.nonceManager;
        this.chainId = config.chainId;
        this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
        this.receiptTimeoutMs = config.receiptTimeoutMs ?? 120_000;
    }
    // ── Build ───────────────────────────────────────────────────────────────────
    async build(request) {
        return {
            opportunityId: request.opportunityId,
            cycleId: request.cycleId,
            to: request.to,
            data: request.data,
            value: request.value ?? 0n,
            chainId: request.chainId,
            payloadHash: request.payloadHash,
        };
    }
    // ── Sign ────────────────────────────────────────────────────────────────────
    async sign(request) {
        const { Web3 } = await getWeb3();
        const web3 = new Web3(this.rpcUrl);
        // Derive signer address from key using ethers (no extra dep needed)
        const { Wallet } = await import('ethers');
        const wallet = new Wallet(request.signerPrivateKey);
        const signerAddress = wallet.address;
        const nonce = request.nonce ??
            (await this.nonceManager.acquire(request.chainId, signerAddress));
        const txObject = {
            chainId: request.chainId,
            nonce,
            to: request.to,
            data: request.data,
            value: (request.value ?? 0n).toString(),
            gas: request.gasLimit.toString(),
            maxFeePerGas: request.maxFeePerGas.toString(),
            maxPriorityFeePerGas: request.maxPriorityFeePerGas.toString(),
            type: '0x2',
        };
        const accounts = web3.eth;
        const signed = await accounts.accounts.signTransaction(txObject, request.signerPrivateKey);
        return {
            opportunityId: request.opportunityId,
            cycleId: request.cycleId,
            to: request.to,
            data: request.data,
            value: request.value ?? 0n,
            chainId: request.chainId,
            payloadHash: request.payloadHash,
            nonce,
            gasLimit: request.gasLimit,
            maxFeePerGas: request.maxFeePerGas,
            maxPriorityFeePerGas: request.maxPriorityFeePerGas,
            rawTx: signed.rawTransaction,
            signerAddress,
        };
    }
    // ── Submit (public RPC) ──────────────────────────────────────────────────────
    async submitPublic(signed, request) {
        if (!request.publicFallback) {
            return this.buildFailedResult(signed, request, 'PUBLIC_FALLBACK_DISABLED');
        }
        const { Web3 } = await getWeb3();
        const web3 = new Web3(this.rpcUrl);
        try {
            const txHash = await new Promise((resolve, reject) => {
                const emitter = web3.eth.sendSignedTransaction(signed.rawTx);
                emitter.on('transactionHash', resolve);
                emitter.on('error', reject);
            });
            const blockNum = Number(await web3.eth.getBlockNumber());
            return {
                opportunityId: request.opportunityId,
                cycleId: request.cycleId,
                cycleType: request.cycleType,
                submitterAdapter: 'web3',
                nonce: signed.nonce,
                gasLimit: signed.gasLimit.toString(),
                maxFeePerGas: signed.maxFeePerGas.toString(),
                maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
                submittedBlock: blockNum,
                expiresAtBlock: request.expiresAtBlock,
                txHash,
                rawTxHash: keccak256(signed.rawTx),
                payloadHash: request.payloadHash,
                routeHash: request.routeHash,
                stateHash: request.stateHash,
                configHash: request.configHash,
                submissionStatus: 'SUBMITTED_PUBLIC',
                receiptStatus: 'PENDING',
            };
        }
        catch (err) {
            return this.buildFailedResult(signed, request, err instanceof Error ? err.message : String(err));
        }
    }
    // ── Wait for receipt ─────────────────────────────────────────────────────────
    async waitForReceipt(txHash, timeoutMs) {
        const { Web3 } = await getWeb3();
        const web3 = new Web3(this.rpcUrl);
        const deadline = Date.now() + (timeoutMs ?? this.receiptTimeoutMs);
        while (Date.now() < deadline) {
            const raw = await web3.eth.getTransactionReceipt(txHash);
            if (raw) {
                return ReceiptNormalizer.fromWeb3(raw);
            }
            await sleep(this.pollIntervalMs);
        }
        throw new Error(`Web3Adapter: receipt timeout for tx ${txHash} after ${timeoutMs ?? this.receiptTimeoutMs}ms`);
    }
    // ── Internal helpers ─────────────────────────────────────────────────────────
    buildFailedResult(signed, request, errorMsg) {
        return {
            opportunityId: request.opportunityId,
            cycleId: request.cycleId,
            cycleType: request.cycleType,
            submitterAdapter: 'web3',
            nonce: signed.nonce,
            gasLimit: signed.gasLimit.toString(),
            maxFeePerGas: signed.maxFeePerGas.toString(),
            maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
            submittedBlock: 0,
            expiresAtBlock: request.expiresAtBlock,
            txHash: '',
            rawTxHash: keccak256(signed.rawTx),
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
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
//# sourceMappingURL=Web3Adapter.js.map