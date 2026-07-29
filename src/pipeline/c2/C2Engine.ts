/**
 * C2Engine — hooks for the C2 (second-cycle) MIRROR / REVERSE / NOOP path.
 *
 * C2 INVARIANTS:
 *  1. C2 NEVER submits before the parent C1 receipt is confirmed.
 *  2. Post-C1 state is always reloaded before C2 sizing.
 *  3. C2 is only valid in blocks N+1 to N+5 relative to C1 confirmation.
 *  4. C2 profit is written separately — never merged with C1.
 *  5. NOOP is a valid and explicitly logged outcome.
 *
 * Flow:
 *   1. Assert parent C1 is CONFIRMED (receiptStatus === true)
 *   2. Reload post-C1 pool state
 *   3. Evaluate MIRROR / REVERSE / NOOP
 *   4. If NOOP → log and return
 *   5. Request fresh nonce
 *   6. sign() → submit() via TxSubmitter
 *   7. wait() for NormalizedReceipt
 *   8. Write c2_cycle settlement record
 *   9. Emit LedgerRecord
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import type {
  ApexTxRequest,
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

export type C2Decision = 'MIRROR' | 'REVERSE' | 'NOOP';

export interface C2ExecutionRequest {
  opportunityId: string;
  cycleId: string;
  config: ConfigRecord;

  // Parent C1 evidence — required for invariant checks
  parentC1TxHash: string;
  parentC1ConfirmedBlock: number;
  parentC1ReceiptStatus: boolean;     // must be true

  // Post-C1 reloaded state
  postC1State: StateRecord;

  // C2 route (may be mirror or reverse of C1 route)
  c2Route: RouteRecord;
  c2Decision: C2Decision;

  // Execution parameters
  executor: string;
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

  // Evidence hashes
  opportunityHash: string;
  payloadHash: string;
  simulationHash?: string;

  // Block window: C2 must land in [c1Block+1, c1Block+5]
  maxBlockOffset?: number;  // default 5
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

// ── C2Engine ──────────────────────────────────────────────────────────────────

export class C2Engine {
  private readonly submitter: TxSubmitter;
  private readonly logger: AuditLogger;

  constructor(submitter: TxSubmitter, logger?: AuditLogger) {
    this.submitter = submitter;
    this.logger = logger ?? new AuditLogger();
  }

  async execute(req: C2ExecutionRequest): Promise<C2ExecutionResult> {
    const chain = new EvidenceChain(
      req.opportunityId,
      req.config.configVersion,
      req.config.configHash,
    );
    chain.setConfig(req.config);
    chain.setState(req.postC1State);
    chain.setRoute(req.c2Route);

    const postC1StateHash = req.postC1State.stateHash;
    const c2RouteHash     = keccak256(toUtf8Bytes(JSON.stringify(req.c2Route)));

    chain.setC2({
      cycleId: req.cycleId,
      parentC1TxHash: req.parentC1TxHash,
      postC1StateHash,
      c2Decision: req.c2Decision,
      c2RouteHash,
      c2SimHash: req.simulationHash,
    });

    // ── Invariant 1: Parent C1 must be confirmed ───────────────────────────────
    if (!req.parentC1ReceiptStatus) {
      this.logger.logRejection({
        opportunityId: req.opportunityId,
        stage: 'SUBMISSION',
        status: 'REJECTED',
        reason: 'C2_PARENT_NOT_CONFIRMED',
        configVersion: req.config.configVersion,
        stateHash: postC1StateHash,
        routeHash: c2RouteHash,
        detail: `Parent C1 tx ${req.parentC1TxHash} did not confirm`,
        timestamp: Date.now(),
      });
      return {
        cycleId: req.cycleId,
        decision: req.c2Decision,
        skipped: true,
        evidenceChain: chain,
      };
    }

    // ── Invariant 2: Must be within block window ────────────────────────────────
    const maxOffset = req.maxBlockOffset ?? 5;
    const currentBlock = req.postC1State.blockNumber;
    const offsetFromC1 = currentBlock - req.parentC1ConfirmedBlock;

    if (offsetFromC1 < 1 || offsetFromC1 > maxOffset) {
      this.logger.logRejection({
        opportunityId: req.opportunityId,
        stage: 'SUBMISSION',
        status: 'REJECTED',
        reason: 'STATE_TOO_OLD',
        configVersion: req.config.configVersion,
        stateHash: postC1StateHash,
        detail: `C2 block offset ${offsetFromC1} outside [1, ${maxOffset}]`,
        timestamp: Date.now(),
      });
      return {
        cycleId: req.cycleId,
        decision: req.c2Decision,
        skipped: true,
        evidenceChain: chain,
      };
    }

    // ── Invariant 3: NOOP is valid — log and return ────────────────────────────
    if (req.c2Decision === 'NOOP') {
      this.logger.logRejection({
        opportunityId: req.opportunityId,
        stage: 'PROFIT_GATE',
        status: 'REJECTED',
        reason: 'NET_PROFIT_BELOW_MINIMUM',
        configVersion: req.config.configVersion,
        stateHash: postC1StateHash,
        routeHash: c2RouteHash,
        detail: 'C2 decision: NOOP — no profitable continuation found',
        timestamp: Date.now(),
      });
      return {
        cycleId: req.cycleId,
        decision: 'NOOP',
        skipped: true,
        evidenceChain: chain,
      };
    }

    // ── Execute C2 ─────────────────────────────────────────────────────────────
    const txRequest: ApexTxRequest = {
      opportunityId: req.opportunityId,
      cycleType: 'C2',
      cycleId: req.cycleId,
      chainId: req.postC1State.chainId,
      blockNumber: req.postC1State.blockNumber,
      signerPrivateKey: req.signerPrivateKey,
      gasLimit: req.gasLimit,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      to: req.executor,
      data: req.encodedRoutePayload,
      opportunityHash: req.opportunityHash,
      payloadHash: req.payloadHash,
      routeHash: c2RouteHash,
      stateHash: postC1StateHash,
      configHash: req.config.configHash,
      configVersion: req.config.configVersion,
      privateRelayFirst: true,
      publicFallback: req.publicFallback,
      relayEndpoint: req.relayEndpoint,
      expiresAtBlock: req.expiresAtBlock,
    };

    const signed     = await this.submitter.sign(txRequest);
    const submission = await this.submitter.submit(signed);
    this.logger.logSubmission(req.opportunityId, submission);
    chain.setSubmission(submission);

    const receipt = await this.submitter.wait(submission.txHash);
    this.logger.logReceipt(req.opportunityId, receipt);

    const ledgerRecord: LedgerRecord = {
      opportunityId: req.opportunityId,
      cycleType: 'C2',
      cycleId: req.cycleId,
      submitterAdapter: submission.submitterAdapter,
      nonce: submission.nonce,
      rawTxHash: submission.rawTxHash,
      txHash: submission.txHash,
      payloadHash: req.payloadHash,
      routeHash: c2RouteHash,
      stateHash: postC1StateHash,
      configHash: req.config.configHash,
      configVersion: req.config.configVersion,
      submissionStatus: submission.submissionStatus,
      receiptStatus: receipt.receiptStatus ? 'CONFIRMED' : 'REVERTED',
      settledAt: Date.now(),
    };

    this.logger.logLedger(req.opportunityId, ledgerRecord);

    chain.setC2({
      cycleId: req.cycleId,
      parentC1TxHash: req.parentC1TxHash,
      postC1StateHash,
      c2Decision: req.c2Decision,
      c2RouteHash,
      c2SimHash: req.simulationHash,
      c2TxHash: submission.txHash,
    });

    return {
      cycleId: req.cycleId,
      decision: req.c2Decision,
      skipped: false,
      submission,
      receipt,
      ledgerRecord,
      evidenceChain: chain,
    };
  }
}
