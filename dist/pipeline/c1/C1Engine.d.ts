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
import type { ConfigRecord, LedgerRecord, NormalizedReceipt, RouteRecord, StateRecord, SubmissionResult, TxSubmitter } from '../../types/index.js';
import { EvidenceChain } from '../transparency/EvidenceChain.js';
import { AuditLogger } from '../transparency/AuditLogger.js';
export type C1FlashProvider = 'aave' | 'balancer';
export declare const C1_SELECTORS: Record<C1FlashProvider, string>;
export interface C1ExecutionRequest {
    opportunityId: string;
    cycleId: string;
    config: ConfigRecord;
    state: StateRecord;
    route: RouteRecord;
    executor: string;
    flashProvider: C1FlashProvider;
    encodedRoutePayload: string;
    borrowAsset: string;
    borrowAmount: bigint;
    minFinalAmount: bigint;
    deadline: number;
    signerPrivateKey: string;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    expiresAtBlock: number;
    relayEndpoint: string;
    publicFallback: boolean;
    opportunityHash: string;
    payloadHash: string;
    stateHash: string;
    simulationHash?: string;
}
export interface C1ExecutionResult {
    cycleId: string;
    submission: SubmissionResult;
    receipt: NormalizedReceipt;
    ledgerRecord: LedgerRecord;
    evidenceChain: EvidenceChain;
}
export declare class C1Engine {
    private readonly submitter;
    private readonly logger;
    constructor(submitter: TxSubmitter, logger?: AuditLogger);
    execute(req: C1ExecutionRequest): Promise<C1ExecutionResult>;
}
//# sourceMappingURL=C1Engine.d.ts.map