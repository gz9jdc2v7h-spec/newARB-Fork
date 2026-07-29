/**
 * EthersV6Adapter — primary signing and submission adapter using ethers v6.
 *
 * Responsibilities:
 *  - Build a typed EIP-1559 transaction from an ApexTxRequest.
 *  - Sign it locally (never broadcasts from this method).
 *  - Submit directly to an RPC provider (public path, disabled by default).
 *  - Wait for and normalize the receipt.
 */
import { JsonRpcProvider } from 'ethers';
import type { ApexTxRequest, BuiltTx, NormalizedReceipt, SignedTx, SubmissionResult } from '../types/index.js';
import { NonceManager } from '../nonce/NonceManager.js';
export interface EthersV6AdapterConfig {
    provider: JsonRpcProvider;
    nonceManager: NonceManager;
    chainId: number;
    /** Receipt poll interval in ms (default 2000). */
    pollIntervalMs?: number;
    /** Max wait for receipt in ms (default 120_000). */
    receiptTimeoutMs?: number;
}
export declare class EthersV6Adapter {
    private readonly provider;
    private readonly nonceManager;
    private readonly chainId;
    private readonly pollIntervalMs;
    private readonly receiptTimeoutMs;
    constructor(config: EthersV6AdapterConfig);
    build(request: ApexTxRequest): Promise<BuiltTx>;
    sign(request: ApexTxRequest): Promise<SignedTx>;
    submitPublic(signed: SignedTx, request: ApexTxRequest): Promise<SubmissionResult>;
    waitForReceipt(txHash: string, timeoutMs?: number): Promise<NormalizedReceipt>;
    private buildFailedResult;
}
//# sourceMappingURL=EthersV6Adapter.d.ts.map