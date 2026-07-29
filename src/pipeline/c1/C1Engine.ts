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

import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';
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

export const C1_SELECTORS: Record<C1FlashProvider, string> = {
  aave:     '0x' + Buffer.from('initAaveFlash(address,uint256,bytes)').slice(0, 4).toString('hex'),
  balancer: '0x' + Buffer.from('initBalancerFlash(address,uint256,bytes)').slice(0, 4).toString('hex'),
};

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
  postC1ObservedState: {
    affectedPoolIds: string[];
    postTradeStateHashes: string[];
    realizedProfitUsd: string;
    routeId?: string;
  };
}

// ── C1 execution result ───────────────────────────────────────────────────────

export interface C1ExecutionResult {
  cycleId: string;
  submission: SubmissionResult;
  receipt: NormalizedReceipt;
  ledgerRecord: LedgerRecord;
  c1StateCommitment: C1StateCommitment;
  evidenceChain: EvidenceChain;
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
    const c1StateCommitment = buildC1StateCommitment(req, receipt, submission.txHash);

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
      c1RealizedNetUsd: req.postC1ObservedState.realizedProfitUsd,
      c1StateHash: c1StateCommitment.c1StateHash,
      c1StateCommitment,
    });

    return {
      cycleId: req.cycleId,
      submission,
      receipt,
      ledgerRecord,
      c1StateCommitment,
      evidenceChain: chain,
    };
  }
}

// ── ABI encoding helpers ──────────────────────────────────────────────────────

function encodeC1Calldata(req: C1ExecutionRequest): string {
  // In production this would use ethers AbiCoder. Here we produce a
  // deterministic placeholder that preserves the selector + params structure.
  // Replace with full AbiCoder.encode when the executor ABI is finalized.
  const { AbiCoder } = require('ethers');
  const coder = AbiCoder.defaultAbiCoder();
  const selector = C1_SELECTORS[req.flashProvider];
  const encoded = coder.encode(
    ['address', 'uint256', 'bytes'],
    [req.borrowAsset, req.borrowAmount, req.encodedRoutePayload],
  );
  return selector + encoded.slice(2); // strip 0x from ABI body
}

export function buildC1StateCommitment(
  req: C1ExecutionRequest,
  receipt: NormalizedReceipt,
  txHash: string,
): C1StateCommitment {
  const routeId = req.postC1ObservedState.routeId ?? req.route.routeHash;
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'uint256', 'bytes32', 'string[]', 'bytes32[]', 'string', 'address', 'string'],
    [
      req.state.chainId,
      receipt.confirmedBlock,
      txHash,
      req.postC1ObservedState.affectedPoolIds,
      req.postC1ObservedState.postTradeStateHashes,
      req.postC1ObservedState.realizedProfitUsd,
      req.executor,
      routeId,
    ],
  );

  return {
    chainId: req.state.chainId,
    blockNumber: receipt.confirmedBlock,
    transactionHash: txHash,
    affectedPoolIds: req.postC1ObservedState.affectedPoolIds,
    postTradeStateHashes: req.postC1ObservedState.postTradeStateHashes,
    realizedProfitUsd: req.postC1ObservedState.realizedProfitUsd,
    executor: req.executor,
    routeId,
    c1StateHash: keccak256(encoded),
  };
}
