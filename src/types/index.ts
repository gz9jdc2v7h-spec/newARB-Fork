/**
 * apex-tx-submitter — all public types
 *
 * TxSubmitter is the only surface the rest of the machine sees.
 * Everything else (ethers, web3, relay, nonce) is an internal detail.
 */

// ─── Core submission pipeline ────────────────────────────────────────────────

export type CycleType = 'C1' | 'C2';
export type SubmitterAdapter = 'ethers_v6' | 'web3' | 'private_relay';
export type SubmissionStatus =
  | 'SUBMITTED_PRIVATE'
  | 'SUBMITTED_PUBLIC'
  | 'FAILED'
  | 'REPLACED'
  | 'EXPIRED';
export type ReceiptStatus = 'PENDING' | 'CONFIRMED' | 'REVERTED' | 'EXPIRED';
export type SettlementStatus = 'SETTLED' | 'FAILED' | 'PENDING' | 'REVERTED';
export type MachineMode = 'dry_run' | 'sim_only' | 'live';
export type ExecutionMode = 'dry_run' | 'sequential_live' | 'private_relay_live' | 'atomic_flash';

// ─── Request types ────────────────────────────────────────────────────────────

/** Everything the submitter needs to build, sign, and send one transaction. */
export interface ApexTxRequest {
  // Identity
  opportunityId: string;
  cycleType: CycleType;
  cycleId: string;

  // Chain context
  chainId: number;
  blockNumber: number;

  // Wallet / gas
  signerPrivateKey: string; // never logged
  nonce?: number;           // set by NonceManager if absent
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;

  // Contract call
  to: string;               // executor contract address
  data: string;             // ABI-encoded calldata (from payload_builder)
  value?: bigint;

  // Evidence hashes (all required for ledger invariant)
  opportunityHash: string;
  payloadHash: string;
  routeHash: string;
  stateHash: string;
  configHash: string;
  configVersion: number;

  // Relay policy
  privateRelayFirst: boolean;
  publicFallback: boolean;
  relayEndpoint?: string;

  // Expiry
  expiresAtBlock: number;
}

// ─── Pipeline stages ─────────────────────────────────────────────────────────

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
  rawTx: string;          // RLP-encoded signed tx
  signerAddress: string;  // derived from key — never the key itself
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

// ─── Receipt ─────────────────────────────────────────────────────────────────

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

// ─── Ledger invariant ─────────────────────────────────────────────────────────

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
  settledAt?: number;        // unix ms
  realizedNetUsd?: string;
  settlementStatus?: SettlementStatus;
}

// ─── Transparency / evidence chain ────────────────────────────────────────────

export type RejectionReason =
  | 'STATE_TOO_OLD'
  | 'QUOTE_EXPIRED'
  | 'BUY_PRICE_NOT_LOWER_THAN_SELL_PRICE'
  | 'SAME_POOL'
  | 'NET_PROFIT_BELOW_MINIMUM'
  | 'PROFIT_TO_GAS_TOO_LOW'
  | 'SIMULATION_REVERTED'
  | 'REPAYMENT_FAILED'
  | 'PAYLOAD_ABI_MISMATCH'
  | 'PRIVATE_RELAY_REJECTED'
  | 'PUBLIC_FALLBACK_DISABLED'
  | 'KILL_SWITCH_ACTIVE'
  | 'C2_PARENT_NOT_CONFIRMED'
  | 'NONCE_CONFLICT';

export type PipelineStage =
  | 'DISCOVERY'
  | 'QUOTE'
  | 'SIZE'
  | 'PROFIT_GATE'
  | 'SIMULATION'
  | 'PAYLOAD'
  | 'SUBMISSION'
  | 'SETTLEMENT'
  | 'LEDGER';

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
  timestamp: number; // unix ms
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

  // Sub-records
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

  // C1/C2 breakdown
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

// ─── C1 state commitment ─────────────────────────────────────────────────────

/**
 * The authoritative post-C1 state commitment produced after C1 settlement.
 *
 * H_{C1} = keccak256(encode[
 *   chainId, blockNumber, transactionHash, affectedPoolIds,
 *   postTradeStateHashes, realizedProfit, executor, routeId
 * ])
 *
 * This commits to observed post-transaction state, not the pre-execution
 * prediction.  C2 must reload from this hash before making any decision.
 */
export interface C1StateCommitment {
  /** The authoritative C1_STATE_HASH. */
  c1StateHash: string;
  chainId: number;
  blockNumber: number;
  transactionHash: string;
  /** Deduplicated addresses of pools touched in the C1 receipt logs. */
  affectedPoolIds: string[];
  /** Per-pool post-trade state hash derived from receipt log data. */
  postTradeStateHashes: string[];
  /**
   * Realized net profit in USD (or '0' when settlement has not yet reconciled).
   * The ledger settlement layer may produce a revised commitment once PnL is
   * confirmed; until then this field is '0'.
   */
  realizedProfit: string;
  executor: string;
  routeId: string;
}

// ─── C2 decision function inputs / outputs ───────────────────────────────────

/**
 * Per-route evaluation fed into the D_C2 decision function.
 * Both the MIRROR and REVERSE evaluations must be produced from fresh
 * post-C1 state; never from C1 quotes, sizing, or predictions.
 */
export interface C2RouteEvaluation {
  /** All hard gates pass (state age, simulation, impact, profit floor). */
  valid: boolean;
  /** Net profit in USD computed from fresh post-C1 state. */
  netProfitUsd: number;
  routeHash: string;
  rejectionReasons: string[];
}

/**
 * Inputs to the formal D_C2 terminal decision function.
 *
 * C2 must never reuse: C1 quotes, C1 sizing, C1 pool reserves,
 * C1 minimum outputs, C1 calldata, C1 predicted profit, C1 route rank.
 */
export interface C2DecisionInput {
  /** Authoritative post-C1 state commitment from which this evaluation was derived. */
  c1StateHash: string;
  /** Minimum net profit threshold (USD). */
  minNetProfitUsd: number;
  /** Evaluation of the MIRROR route (same direction as C1). */
  mirrorEval: C2RouteEvaluation;
  /** Evaluation of the REVERSE route (opposite direction). */
  reverseEval: C2RouteEvaluation;
}

/**
 * Output of the D_C2 terminal decision function.
 *
 * D_C2 = MIRROR   when V_M=1 AND N_M >= N_min AND N_M >= N_R
 *       REVERSE   when V_R=1 AND N_R >= N_min AND N_R >  N_M
 *       NO_OP     otherwise
 */
export interface C2DecisionOutput {
  decision: C2Decision;
  /** Expected net profit for the selected route (0 for NO_OP). */
  selectedNetProfitUsd: number;
  selectedRouteHash: string | null;
  rationale: string;
}

export type C2Decision = 'MIRROR' | 'REVERSE' | 'NOOP';

// ─── Liquidation execution lane ──────────────────────────────────────────────

export type LiquidationProtocol = 'aave_v3' | 'compound_v3' | 'morpho';

/**
 * Input to the liquidation execution lane.
 *
 * The liquidation lane is operationally independent from C1 and C2.
 * It must not receive or consume any C1 / C2 state, quotes, or calldata.
 */
export interface LiquidationRequest {
  opportunityId: string;
  cycleId: string;
  config: ConfigRecord;

  // Liquidation target
  protocol: LiquidationProtocol;
  collateralAsset: string;
  debtAsset: string;
  borrowerAddress: string;
  debtToCover: bigint;
  /** Expected collateral received after liquidation penalty. */
  expectedCollateralOut: bigint;

  // Execution parameters
  executor: string;
  encodedLiquidationPayload: string;
  signerPrivateKey: string;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  expiresAtBlock: number;
  relayEndpoint: string;
  publicFallback: boolean;

  // State freshness: must reload independently, never from C1/C2
  state: StateRecord;
  stateHash: string;

  // Economic gate
  minNetProfitUsd: number;
  estimatedNetProfitUsd: number;

  // Evidence hashes
  opportunityHash: string;
  payloadHash: string;
  simulationHash?: string;
}

export interface LiquidationResult {
  cycleId: string;
  protocol: LiquidationProtocol;
  /** false when the economic or state gate prevented execution. */
  executed: boolean;
  skipReason?: string;
  submission?: SubmissionResult;
  receipt?: NormalizedReceipt;
  ledgerRecord?: LedgerRecord;
}

// ─── Main TxSubmitter interface — the ONLY public surface ─────────────────────

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
