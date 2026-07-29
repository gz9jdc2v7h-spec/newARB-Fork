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
import type { ApexTxRequest, BuiltTx, NormalizedReceipt, SignedTx, SubmissionResult } from '../types/index.js';
import { NonceManager } from '../nonce/NonceManager.js';
export interface Web3AdapterConfig {
    rpcUrl: string;
    nonceManager: NonceManager;
    chainId: number;
    pollIntervalMs?: number;
    receiptTimeoutMs?: number;
}
export declare class Web3Adapter {
    private readonly rpcUrl;
    private readonly nonceManager;
    private readonly chainId;
    private readonly pollIntervalMs;
    private readonly receiptTimeoutMs;
    constructor(config: Web3AdapterConfig);
    build(request: ApexTxRequest): Promise<BuiltTx>;
    sign(request: ApexTxRequest): Promise<SignedTx>;
    submitPublic(signed: SignedTx, request: ApexTxRequest): Promise<SubmissionResult>;
    waitForReceipt(txHash: string, timeoutMs?: number): Promise<NormalizedReceipt>;
    private buildFailedResult;
}
//# sourceMappingURL=Web3Adapter.d.ts.map