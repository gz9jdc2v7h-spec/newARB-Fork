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
import type { ConfigRecord, LedgerRecord, NormalizedReceipt, RouteRecord, StateRecord, SubmissionResult, TxSubmitter } from '../../types/index.js';
import { EvidenceChain } from '../transparency/EvidenceChain.js';
import { AuditLogger } from '../transparency/AuditLogger.js';
export type C2Decision = 'MIRROR' | 'REVERSE' | 'NO_OP';
export interface C2ReuseGuard {
    reusedC1Quotes?: boolean;
    reusedC1Sizing?: boolean;
    reusedC1PoolReserves?: boolean;
    reusedC1MinOutputs?: boolean;
    reusedC1Calldata?: boolean;
    reusedC1PredictedProfit?: boolean;
    reusedC1RouteRank?: boolean;
}
export interface C2Candidate {
    route: RouteRecord;
    encodedRoutePayload: string;
    borrowAsset: string;
    borrowAmount: bigint;
    minFinalAmount: bigint;
    deadline: number;
    netProfitUsd: string;
    allGatesPassed: boolean;
    reuseGuard?: C2ReuseGuard;
}
export interface C2ExecutionRequest {
    opportunityId: string;
    cycleId: string;
    config: ConfigRecord;
    parentC1TxHash: string;
    parentC1ConfirmedBlock: number;
    parentC1ReceiptStatus: boolean;
    postC1State: StateRecord;
    mirrorCandidate?: C2Candidate;
    reverseCandidate?: C2Candidate;
    c1StateHash: string;
    reloadedFromC1StateHash: string;
    executor: string;
    signerPrivateKey: string;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    expiresAtBlock: number;
    relayEndpoint: string;
    publicFallback: boolean;
    opportunityHash: string;
    payloadHash: string;
    simulationHash?: string;
    maxBlockOffset?: number;
}
export interface C2ExecutionResult {
    cycleId: string;
    decision: C2Decision;
    skipped: boolean;
    submission?: SubmissionResult;
    receipt?: NormalizedReceipt;
    ledgerRecord?: LedgerRecord;
    evidenceChain: EvidenceChain;
}
export declare class C2Engine {
    private readonly submitter;
    private readonly logger;
    constructor(submitter: TxSubmitter, logger?: AuditLogger);
    execute(req: C2ExecutionRequest): Promise<C2ExecutionResult>;
}
export declare function selectC2Decision(mirrorCandidate: C2Candidate | undefined, reverseCandidate: C2Candidate | undefined, minNetProfitUsd: number): {
    decision: C2Decision;
    selectedCandidate?: C2Candidate;
};
//# sourceMappingURL=C2Engine.d.ts.map