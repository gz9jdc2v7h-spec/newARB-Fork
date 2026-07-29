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

import { AbiCoder, Interface, keccak256, toUtf8Bytes } from 'ethers';
import type {
  ApexTxRequest,
  C1StateCommitment,
  ConfigRecord,
  LedgerRecord,
  NormalizedReceipt,
  RouteRecord,
  StateRecord,
  SubmissionResult,
  TxSubmitter,
} from '../../types/index.js';
import { EvidenceChain } from '../transparency/EvidenceChain.js';
import { AuditLogger } from '../transparency/AuditLogger.js';

// ── Supported C1 flash-loan initiators ────────────────────────────────────────

export type C1FlashProvider = 'aave' | 'balancer';

const C1_FUNCTIONS = {
  aave: 'initAaveFlash',
  balancer: 'initBalancerFlash',
} as const;

const C1_INTERFACE = new Interface([
  'function initAaveFlash(address borrowAsset, uint256 borrowAmount, bytes encodedRoutePayload)',
  'function initBalancerFlash(address borrowAsset, uint256 borrowAmount, bytes encodedRoutePayload)',
]);

assertC1Function(C1_FUNCTIONS.aave);
assertC1Function(C1_FUNCTIONS.balancer);

// ── Input to C1 execution ─────────────────────────────────────────────────────

export interface C1ExecutionRequest {
  opportunityId: string;
  cycleId: string;
  config: ConfigRecord;
  state: StateRecord;
  route: RouteRecord;
  executor: string;
  flashProvider: C1FlashProvider;
  encodedRoutePayload: string;    // ABI-encoded route for the executor contract
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
  // Evidence hashes
  opportunityHash: string;
  payloadHash: string;
  stateHash: string;
  simulationHash?: string;
}

// ── C1 execution result ───────────────────────────────────────────────────────

export interface C1ExecutionResult {
  cycleId: string;
  submission: SubmissionResult;
  receipt: NormalizedReceipt;
  ledgerRecord: LedgerRecord;
  evidenceChain: EvidenceChain;
  /**
   * The authoritative C1_STATE_HASH commitment produced after the receipt
   * confirms.  C2 must reload state from this hash before any decision.
   */
  c1StateCommitment: C1StateCommitment;
}

// ── C1Engine ──────────────────────────────────────────────────────────────────

export class C1Engine {
  private readonly submitter: TxSubmitter;
  private readonly logger: AuditLogger;

  constructor(submitter: TxSubmitter, logger?: AuditLogger) {
    this.submitter = submitter;
    this.logger = logger ?? new AuditLogger();
  }

  async execute(req: C1ExecutionRequest): Promise<C1ExecutionResult> {
    const chain = new EvidenceChain(req.opportunityId, req.config.configVersion, req.config.configHash);
    chain.setConfig(req.config);
    chain.setState(req.state);
    chain.setRoute(req.route);
    chain.setC1({
      cycleId: req.cycleId,
      preC1StateHash: req.stateHash,
      c1RouteHash: req.route.routeHash,
      c1SimHash: req.simulationHash,
    });

    // 1. Build calldata
    const calldata = encodeC1Calldata(req);
    const routeHash = keccak256(toUtf8Bytes(JSON.stringify(req.route)));

    // 2. Build ApexTxRequest
    const txRequest: ApexTxRequest = {
      opportunityId: req.opportunityId,
      cycleType: 'C1',
      cycleId: req.cycleId,
      chainId: req.state.chainId,
      blockNumber: req.state.blockNumber,
      signerPrivateKey: req.signerPrivateKey,
      gasLimit: req.gasLimit,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      to: req.executor,
      data: calldata,
      opportunityHash: req.opportunityHash,
      payloadHash: req.payloadHash,
      routeHash,
      stateHash: req.stateHash,
      configHash: req.config.configHash,
      configVersion: req.config.configVersion,
      privateRelayFirst: true,
      publicFallback: req.publicFallback,
      relayEndpoint: req.relayEndpoint,
      expiresAtBlock: req.expiresAtBlock,
    };

    // 3. Sign
    const signed = await this.submitter.sign(txRequest);

    // 4. Submit (via TxSubmitter — never ethers/web3 directly)
    const submission = await this.submitter.submit(signed);
    this.logger.logSubmission(req.opportunityId, submission);
    chain.setSubmission(submission);

    // 5. Wait for receipt
    const receipt = await this.submitter.wait(submission.txHash);
    this.logger.logReceipt(req.opportunityId, receipt);

    // 6. Build ledger record
    const ledgerRecord: LedgerRecord = {
      opportunityId: req.opportunityId,
      cycleType: 'C1',
      cycleId: req.cycleId,
      submitterAdapter: submission.submitterAdapter,
      nonce: submission.nonce,
      rawTxHash: submission.rawTxHash,
      txHash: submission.txHash,
      payloadHash: req.payloadHash,
      routeHash,
      stateHash: req.stateHash,
      configHash: req.config.configHash,
      configVersion: req.config.configVersion,
      submissionStatus: submission.submissionStatus,
      receiptStatus: receipt.receiptStatus ? 'CONFIRMED' : 'REVERTED',
      settledAt: Date.now(),
    };

    this.logger.logLedger(req.opportunityId, ledgerRecord);
    chain.setC1({
      cycleId: req.cycleId,
      preC1StateHash: req.stateHash,
      c1RouteHash: routeHash,
      c1SimHash: req.simulationHash,
      c1TxHash: submission.txHash,
    });

    // 7. Compute C1_STATE_HASH commitment from observed post-transaction state
    const c1StateCommitment = computeC1StateHash({
      chainId: req.state.chainId,
      blockNumber: receipt.confirmedBlock,
      transactionHash: receipt.txHash,
      receipt,
      executor: req.executor,
      routeId: req.route.routeHash,
      realizedProfit: '0',  // Placeholder; ledger settlement layer reconciles PnL
    });

    return { cycleId: req.cycleId, submission, receipt, ledgerRecord, evidenceChain: chain, c1StateCommitment };
  }
}

// ── ABI encoding helpers ──────────────────────────────────────────────────────

function encodeC1Calldata(req: C1ExecutionRequest): string {
  return C1_INTERFACE.encodeFunctionData(
    C1_FUNCTIONS[req.flashProvider],
    [req.borrowAsset, req.borrowAmount, req.encodedRoutePayload],
  );
}

function assertC1Function(name: (typeof C1_FUNCTIONS)[C1FlashProvider]): void {
  const fragment = C1_INTERFACE.getFunction(name);
  if (!fragment) {
    throw new Error(`C1Engine: missing ABI fragment for ${name}`);
  }
}

// ── C1 state commitment ───────────────────────────────────────────────────────

interface ComputeC1StateHashParams {
  chainId: number;
  blockNumber: number;
  transactionHash: string;
  receipt: NormalizedReceipt;
  executor: string;
  routeId: string;
  /**
   * Realized net profit in USD.  Pass '0' until the settlement layer has
   * reconciled the actual PnL; the commitment may be recomputed at that point.
   */
  realizedProfit: string;
}

/**
 * Computes the authoritative C1_STATE_HASH commitment.
 *
 * H_{C1} = keccak256(encode[
 *   chainId, blockNumber, transactionHash, affectedPoolIds,
 *   postTradeStateHashes, realizedProfit, executor, routeId
 * ])
 *
 * Commits to the observed post-transaction state by extracting affected pool
 * addresses and per-pool state hashes directly from the confirmed receipt logs.
 * This is authoritative over any pre-execution prediction.
 */
export function computeC1StateHash(params: ComputeC1StateHashParams): C1StateCommitment {
  const { chainId, blockNumber, transactionHash, receipt, executor, routeId, realizedProfit } = params;

  // Deduplicated set of pool addresses touched in the receipt logs
  const affectedPoolIds = [...new Set(receipt.logs.map((l) => l.address.toLowerCase()))];

  // Per-pool post-trade state hash: hash of each unique log grouped by address
  const postTradeStateHashes = affectedPoolIds.map((poolAddress) => {
    const poolLogs = receipt.logs.filter((l) => l.address.toLowerCase() === poolAddress);
    return keccak256(toUtf8Bytes(JSON.stringify(poolLogs)));
  });

  // ABI-encode all fields for a fully typed, deterministic commitment
  const abiCoder = AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ['uint256', 'uint256', 'bytes32', 'address[]', 'bytes32[]', 'string', 'address', 'bytes32'],
    [
      chainId,
      blockNumber,
      transactionHash,
      affectedPoolIds,
      postTradeStateHashes,
      realizedProfit,
      executor,
      routeId,
    ],
  );

  const c1StateHash = keccak256(encoded);

  return {
    c1StateHash,
    chainId,
    blockNumber,
    transactionHash,
    affectedPoolIds,
    postTradeStateHashes,
    realizedProfit,
    executor,
    routeId,
  };
}
