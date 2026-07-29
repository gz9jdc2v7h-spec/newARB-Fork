/**
 * LiquidationEngine — third independent execution lane.
 *
 * The liquidation lane is operationally independent from C1 and C2.
 * It shares discovery infrastructure, protocol adapters, pricing, simulation,
 * accounting, and execution contracts, but it MUST NOT share:
 *  - Any C1 or C2 state, quotes, calldata, or route data.
 *  - Any pre-computed execution assumptions from C1 or C2.
 *
 * Each liquidation opportunity is evaluated with a fresh state load.
 *
 * Flow:
 *   1. Assert economic gate — estimatedNetProfitUsd >= minNetProfitUsd
 *   2. Assert state freshness — stateAgeBlocks <= maxStateAgeBlocks
 *   3. Assert kill switch not active
 *   4. Build ApexTxRequest from liquidation payload
 *   5. sign() → submit() via TxSubmitter (private relay first)
 *   6. wait() for NormalizedReceipt
 *   7. Write liquidation settlement record to ledger
 *   8. Emit LedgerRecord
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import type {
  ApexTxRequest,
  LedgerRecord,
  LiquidationRequest,
  LiquidationResult,
  TxSubmitter,
} from '../../types/index.js';
import { AuditLogger } from '../transparency/AuditLogger.js';

// ── LiquidationEngine ─────────────────────────────────────────────────────────

export class LiquidationEngine {
  private readonly submitter: TxSubmitter;
  private readonly logger: AuditLogger;

  constructor(submitter: TxSubmitter, logger?: AuditLogger) {
    this.submitter = submitter;
    this.logger = logger ?? new AuditLogger();
  }

  async execute(req: LiquidationRequest): Promise<LiquidationResult> {
    const opportunityId = req.opportunityId;

    // ── Gate 1: Kill switch ────────────────────────────────────────────────────
    if (req.config.killSwitch) {
      const reason = 'KILL_SWITCH_ACTIVE';
      this.logger.logRejection({
        opportunityId,
        stage: 'SUBMISSION',
        status: 'REJECTED',
        reason,
        configVersion: req.config.configVersion,
        stateHash: req.stateHash,
        detail: 'Liquidation skipped — kill switch is active',
        timestamp: Date.now(),
      });
      return { cycleId: req.cycleId, protocol: req.protocol, executed: false, skipReason: reason };
    }

    // ── Gate 2: State freshness ────────────────────────────────────────────────
    if (req.state.stateAgeBlocks > req.state.maxStateAgeBlocks) {
      const reason = 'STATE_TOO_OLD';
      this.logger.logRejection({
        opportunityId,
        stage: 'DISCOVERY',
        status: 'REJECTED',
        reason,
        configVersion: req.config.configVersion,
        stateHash: req.stateHash,
        detail:
          `State age ${req.state.stateAgeBlocks} blocks exceeds maximum ` +
          `${req.state.maxStateAgeBlocks} blocks`,
        timestamp: Date.now(),
      });
      return { cycleId: req.cycleId, protocol: req.protocol, executed: false, skipReason: reason };
    }

    // ── Gate 3: Economic gate ─────────────────────────────────────────────────
    if (req.estimatedNetProfitUsd < req.minNetProfitUsd) {
      const reason = 'NET_PROFIT_BELOW_MINIMUM';
      this.logger.logRejection({
        opportunityId,
        stage: 'PROFIT_GATE',
        status: 'REJECTED',
        reason,
        netProfitUsd: req.estimatedNetProfitUsd.toFixed(4),
        requiredMinNetProfitUsd: req.minNetProfitUsd.toFixed(4),
        configVersion: req.config.configVersion,
        stateHash: req.stateHash,
        detail:
          `Estimated net profit $${req.estimatedNetProfitUsd.toFixed(4)} is below ` +
          `minimum $${req.minNetProfitUsd.toFixed(4)}`,
        timestamp: Date.now(),
      });
      return { cycleId: req.cycleId, protocol: req.protocol, executed: false, skipReason: reason };
    }

    // ── Build and submit transaction ──────────────────────────────────────────
    const routeHash = keccak256(
      toUtf8Bytes(
        JSON.stringify({
          protocol: req.protocol,
          collateralAsset: req.collateralAsset,
          debtAsset: req.debtAsset,
          borrowerAddress: req.borrowerAddress,
          debtToCover: req.debtToCover.toString(),
        }),
      ),
    );

    const txRequest: ApexTxRequest = {
      opportunityId,
      cycleType: 'LIQUIDATION',
      cycleId: req.cycleId,
      chainId: req.state.chainId,
      blockNumber: req.state.blockNumber,
      signerPrivateKey: req.signerPrivateKey,
      gasLimit: req.gasLimit,
      maxFeePerGas: req.maxFeePerGas,
      maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      to: req.executor,
      data: req.encodedLiquidationPayload,
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

    const signed     = await this.submitter.sign(txRequest);
    const submission = await this.submitter.submit(signed);
    this.logger.logSubmission(opportunityId, submission);

    const receipt = await this.submitter.wait(submission.txHash);
    this.logger.logReceipt(opportunityId, receipt);

    const ledgerRecord: LedgerRecord = {
      opportunityId,
      cycleType: 'LIQUIDATION',
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

    this.logger.logLedger(opportunityId, ledgerRecord);

    return {
      cycleId: req.cycleId,
      protocol: req.protocol,
      executed: true,
      submission,
      receipt,
      ledgerRecord,
    };
  }
}
