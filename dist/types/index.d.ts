/**
 * apex-tx-submitter — all public types
 *
 * TxSubmitter is the only surface the rest of the machine sees.
 * Everything else (ethers, web3, relay, nonce) is an internal detail.
 */
export type CycleType = 'C1' | 'C2';
export type SubmitterAdapter = 'ethers_v6' | 'web3' | 'private_relay';
export type SubmissionStatus = 'SUBMITTED_PRIVATE' | 'SUBMITTED_PUBLIC' | 'FAILED' | 'REPLACED' | 'EXPIRED';
export type ReceiptStatus = 'PENDING' | 'CONFIRMED' | 'REVERTED' | 'EXPIRED';
export type SettlementStatus = 'SETTLED' | 'FAILED' | 'PENDING' | 'REVERTED';
export type MachineMode = 'dry_run' | 'sim_only' | 'live';
export type ExecutionMode = 'dry_run' | 'sequential_live' | 'private_relay_live' | 'atomic_flash';
/** Everything the submitter needs to build, sign, and send one transaction. */
export interface ApexTxRequest {
    opportunityId: string;
    cycleType: CycleType;
    cycleId: string;
    chainId: number;
    blockNumber: number;
    signerPrivateKey: string;
    nonce?: number;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    to: string;
    data: string;
    value?: bigint;
    opportunityHash: string;
    payloadHash: string;
    routeHash: string;
    stateHash: string;
    configHash: string;
    configVersion: number;
    privateRelayFirst: boolean;
    publicFallback: boolean;
    relayEndpoint?: string;
    expiresAtBlock: number;
}
/** Stage 1: calldata built and validated */
export interface BuiltTx {
    opportunityId: string;
    cycleId: string;
    to: string;
    data: string;
    value: bigint;
    chainId: number;
    payloadHash: string;
}
/** Stage 2: transaction signed, ready to broadcast */
export interface SignedTx extends BuiltTx {
    nonce: number;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    rawTx: string;
    signerAddress: string;
}
/** Stage 3: result of broadcast attempt */
export interface SubmissionResult {
    opportunityId: string;
    cycleId: string;
    cycleType: CycleType;
    submitterAdapter: SubmitterAdapter;
    relay?: string;
    nonce: number;
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    submittedBlock: number;
    expiresAtBlock: number;
    txHash: string;
    rawTxHash: string;
    payloadHash: string;
    routeHash: string;
    stateHash: string;
    configHash: string;
    submissionStatus: SubmissionStatus;
    receiptStatus: ReceiptStatus;
    relayResponse?: string;
    error?: string;
}
/** Single internal receipt format regardless of adapter origin. */
export interface NormalizedReceipt {
    txHash: string;
    receiptStatus: boolean;
    confirmedBlock: number;
    gasUsed: string;
    effectiveGasPrice: string;
    gasCostWei: string;
    from: string;
    to: string;
    contractAddress?: string;
    logs: NormalizedLog[];
    rawReceipt: Record<string, unknown>;
}
export interface NormalizedLog {
    address: string;
    topics: string[];
    data: string;
    logIndex: number;
    transactionHash: string;
    blockNumber: number;
}
/** Every submission MUST emit this record. */
export interface LedgerRecord {
    opportunityId: string;
    cycleType: CycleType;
    cycleId: string;
    submitterAdapter: SubmitterAdapter;
    nonce: number;
    rawTxHash: string;
    txHash: string;
    payloadHash: string;
    routeHash: string;
    stateHash: string;
    configHash: string;
    configVersion: number;
    submissionStatus: SubmissionStatus;
    receiptStatus: ReceiptStatus;
    settledAt?: number;
    realizedNetUsd?: string;
    settlementStatus?: SettlementStatus;
}
export type RejectionReason = 'STATE_TOO_OLD' | 'QUOTE_EXPIRED' | 'BUY_PRICE_NOT_LOWER_THAN_SELL_PRICE' | 'SAME_POOL' | 'NET_PROFIT_BELOW_MINIMUM' | 'PROFIT_TO_GAS_TOO_LOW' | 'SIMULATION_REVERTED' | 'REPAYMENT_FAILED' | 'PAYLOAD_ABI_MISMATCH' | 'PRIVATE_RELAY_REJECTED' | 'PUBLIC_FALLBACK_DISABLED' | 'KILL_SWITCH_ACTIVE' | 'C2_PARENT_NOT_CONFIRMED' | 'NONCE_CONFLICT';
export type PipelineStage = 'DISCOVERY' | 'QUOTE' | 'SIZE' | 'PROFIT_GATE' | 'SIMULATION' | 'PAYLOAD' | 'SUBMISSION' | 'SETTLEMENT' | 'LEDGER';
export interface RejectionRecord {
    opportunityId: string;
    stage: PipelineStage;
    status: 'REJECTED';
    reason: RejectionReason;
    netProfitUsd?: string;
    requiredMinNetProfitUsd?: string;
    configVersion: number;
    stateHash?: string;
    routeHash?: string;
    detail?: string;
    timestamp: number;
}
export interface ConfigRecord {
    configVersion: number;
    configHash: string;
    mode: MachineMode;
    minNetProfitUsd: string;
    minProfitToGasRatio: string;
    maxPoolUsageRatio: string;
    privateRelayFirst: boolean;
    publicFallback: boolean;
    killSwitch: boolean;
    c2Enabled: boolean;
    enabledVenues: string[];
    enabledAssets: string[];
    gasCap: string;
}
export interface StateRecord {
    chainId: number;
    blockNumber: number;
    blockHash: string;
    buyPool: string;
    sellPool: string;
    poolFamily: string;
    token0: string;
    token1: string;
    stateHash: string;
    observedAtMs: number;
    stateAgeBlocks: number;
    maxStateAgeBlocks: number;
}
export interface RouteStep {
    venue: string;
    pool: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    expectedOut: string;
    feeTier?: number;
}
export interface RouteRecord {
    borrowAsset: string;
    borrowAmount: string;
    steps: RouteStep[];
    minOut: string;
    deadline: number;
    routeHash: string;
}
export interface ProfitRecord {
    expectedGrossUsd: string;
    flashFeeUsd: string;
    dexFeeUsd: string;
    gasEstimateUsd: string;
    riskBufferUsd: string;
    mevBufferUsd: string;
    expectedNetUsd: string;
    simulatedNetUsd?: string;
    submittedNetUsd?: string;
    realizedNetUsd?: string;
    sizingMethod?: string;
    invariantFamilies?: string[];
}
export interface SimulationRecord {
    simulationStatus: 'PASSED' | 'FAILED';
    forkBlock: number;
    executor: string;
    functionName: string;
    calldataHash: string;
    repaymentVerified: boolean;
    expectedFinalAmount: string;
    simulatedFinalAmount: string;
    quoteToSimDriftBps: string;
    gasUsed: string;
    simulationHash: string;
    error?: string;
}
export interface PayloadRecord {
    payloadStatus: 'BUILT' | 'INVALID';
    executor: string;
    method: string;
    selector: string;
    opportunityHash: string;
    routeHash: string;
    stateHash: string;
    configHash: string;
    payloadHash: string;
}
export interface SettlementRecord {
    txHash: string;
    receiptStatus: boolean;
    confirmedBlock: number;
    gasUsed: string;
    effectiveGasPrice: string;
    preBalanceUsdc: string;
    postBalanceUsdc: string;
    realizedNetUsd: string;
    settlementStatus: SettlementStatus;
}
export interface MarketContextRecord {
    observedEventCount: number;
    latestBlockNumber?: number;
    pendingTxCount?: number;
    quoteAgeMs?: number;
}
export interface ExecutionDecisionRecord {
    mode: ExecutionMode;
    shouldExecute: boolean;
    rationale: string;
    riskFlags: string[];
}
/** Complete evidence chain for one opportunity. */
export interface OpportunityEvidenceChain {
    opportunityId: string;
    configVersion: number;
    configHash: string;
    stateHash: string;
    routeHash: string;
    simulationHash?: string;
    payloadHash?: string;
    txHash?: string;
    settlementStatus?: SettlementStatus;
    realizedNetUsd?: string;
    config?: ConfigRecord;
    state?: StateRecord;
    route?: RouteRecord;
    profit?: ProfitRecord;
    marketContext?: MarketContextRecord;
    simulation?: SimulationRecord;
    payload?: PayloadRecord;
    submission?: SubmissionResult;
    settlement?: SettlementRecord;
    rejection?: RejectionRecord;
    executionDecision?: ExecutionDecisionRecord;
    c1?: {
        cycleId: string;
        preC1StateHash: string;
        c1RouteHash: string;
        c1SimHash?: string;
        c1TxHash?: string;
        c1RealizedNetUsd?: string;
    };
    c2?: {
        cycleId: string;
        parentC1TxHash: string;
        postC1StateHash: string;
        c2Decision: 'MIRROR' | 'REVERSE' | 'NOOP';
        c2RouteHash?: string;
        c2SimHash?: string;
        c2TxHash?: string;
        c2RealizedNetUsd?: string;
    };
}
/**
 * TxSubmitter is the controlled transaction gateway.
 *
 * No scanner, route engine, C1 engine, or C2 engine should call ethers/web3
 * directly. They call TxSubmitter.submit(…) only.
 */
export interface TxSubmitter {
    build(request: ApexTxRequest): Promise<BuiltTx>;
    sign(request: ApexTxRequest): Promise<SignedTx>;
    submit(signed: SignedTx): Promise<SubmissionResult>;
    wait(txHash: string, timeoutMs?: number): Promise<NormalizedReceipt>;
}
//# sourceMappingURL=index.d.ts.map