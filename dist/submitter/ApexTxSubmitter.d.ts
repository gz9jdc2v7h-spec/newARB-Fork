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
import type { ApexTxRequest, BuiltTx, NormalizedReceipt, SignedTx, SubmissionResult, TxSubmitter } from '../types/index.js';
import { AuditLogger } from '../pipeline/transparency/AuditLogger.js';
export interface ApexTxSubmitterConfig {
    /** JSON-RPC URL for signing and receipt polling. */
    rpcUrl: string;
    chainId: number;
    /** Private relay config. Required when privateRelayFirst = true. */
    relay?: {
        endpoint: string;
        relayName?: string;
        authHeader?: string;
        timeoutMs?: number;
    };
    /** Receipt poll interval ms (default 2000). */
    pollIntervalMs?: number;
    /** Receipt wait timeout ms (default 120_000). */
    receiptTimeoutMs?: number;
    /** Audit logger sink (defaults to ConsoleSink). */
    logger?: AuditLogger;
}
export declare class ApexTxSubmitter implements TxSubmitter {
    private readonly provider;
    private readonly nonceManager;
    private readonly ethersAdapter;
    private readonly relaySubmitter?;
    private readonly logger;
    private readonly receiptTimeoutMs;
    constructor(config: ApexTxSubmitterConfig);
    build(request: ApexTxRequest): Promise<BuiltTx>;
    sign(request: ApexTxRequest): Promise<SignedTx>;
    submit(signed: SignedTx): Promise<SubmissionResult>;
    /**
     * Full submit: private relay first (if configured), public fallback only if
     * the request explicitly allows it.
     *
     * This is the method C1 and C2 engines MUST use.
     */
    submitWithRequest(signed: SignedTx, request: ApexTxRequest): Promise<SubmissionResult>;
    wait(txHash: string, timeoutMs?: number): Promise<NormalizedReceipt>;
    private emitLedgerRecord;
    private buildBaseResult;
}
//# sourceMappingURL=ApexTxSubmitter.d.ts.map