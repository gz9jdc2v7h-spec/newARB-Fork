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
import type { ApexTxRequest, NormalizedReceipt, SignedTx, SubmissionResult } from '../types/index.js';
export interface PrivateRelayConfig {
    /** HTTP(S) endpoint for the relay. */
    endpoint: string;
    /** Relay name key used to look up the RPC method. Default: 'default'. */
    relayName?: string;
    /** Auth header value (e.g. ****** Optional. */
    authHeader?: string;
    /** Request timeout in ms. Default 10_000. */
    timeoutMs?: number;
    /** Receipt poll interval ms. Default 2_000. */
    pollIntervalMs?: number;
    /** Receipt wait timeout ms. Default 120_000. */
    receiptTimeoutMs?: number;
    /** External provider for fetching receipts (relay may not support eth_getTransactionReceipt). */
    rpcFallbackUrl?: string;
}
export declare class PrivateRelaySubmitter {
    private readonly endpoint;
    private readonly relayName;
    private readonly authHeader?;
    private readonly timeoutMs;
    private readonly pollIntervalMs;
    private readonly receiptTimeoutMs;
    private readonly rpcFallbackUrl?;
    constructor(config: PrivateRelayConfig);
    submit(signed: SignedTx, request: ApexTxRequest): Promise<SubmissionResult>;
    waitForReceipt(txHash: string, timeoutMs?: number): Promise<NormalizedReceipt>;
    private rpcGetReceipt;
    private fetchCurrentBlock;
    private buildRelayPayload;
    private buildFailedResult;
}
//# sourceMappingURL=PrivateRelaySubmitter.d.ts.map