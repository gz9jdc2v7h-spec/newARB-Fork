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

import { JsonRpcProvider, keccak256 } from 'ethers';
import type {
  ApexTxRequest,
  BuiltTx,
  LedgerRecord,
  NormalizedReceipt,
  SignedTx,
  SubmissionResult,
  TxSubmitter,
} from '../types/index.js';
import { NonceManager } from '../nonce/NonceManager.js';
import { EthersV6Adapter } from '../adapters/EthersV6Adapter.js';
import { PrivateRelaySubmitter } from '../relay/PrivateRelaySubmitter.js';
import { AuditLogger } from '../pipeline/transparency/AuditLogger.js';

const MAX_CACHED_SIGNED_REQUESTS = 512;
type SignedRequestCacheKey = string;

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

export class ApexTxSubmitter implements TxSubmitter {
  private readonly provider: JsonRpcProvider;
  private readonly nonceManager: NonceManager;
  private readonly ethersAdapter: EthersV6Adapter;
  private readonly relaySubmitter?: PrivateRelaySubmitter;
  private readonly logger: AuditLogger;
  private readonly receiptTimeoutMs: number;
  private readonly signedRequestCache = new Map<SignedRequestCacheKey, ApexTxRequest>();

  constructor(config: ApexTxSubmitterConfig) {
    this.provider = new JsonRpcProvider(config.rpcUrl);
    this.nonceManager = new NonceManager(this.provider);
    this.receiptTimeoutMs = config.receiptTimeoutMs ?? 120_000;
    this.logger = config.logger ?? new AuditLogger();

    this.ethersAdapter = new EthersV6Adapter({
      provider: this.provider,
      nonceManager: this.nonceManager,
      chainId: config.chainId,
      pollIntervalMs: config.pollIntervalMs,
      receiptTimeoutMs: config.receiptTimeoutMs,
    });

    if (config.relay) {
      this.relaySubmitter = new PrivateRelaySubmitter({
        endpoint: config.relay.endpoint,
        relayName: config.relay.relayName,
        authHeader: config.relay.authHeader,
        timeoutMs: config.relay.timeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        receiptTimeoutMs: config.receiptTimeoutMs,
        rpcFallbackUrl: config.rpcUrl,
      });
    }
  }

  // ── TxSubmitter interface ─────────────────────────────────────────────────

  async build(request: ApexTxRequest): Promise<BuiltTx> {
    return this.ethersAdapter.build(request);
  }

  async sign(request: ApexTxRequest): Promise<SignedTx> {
    const signed = await this.ethersAdapter.sign(request);
    const cacheKey: SignedRequestCacheKey = keccak256(signed.rawTx);
    this.ensureCacheCapacityFor(cacheKey);
    this.signedRequestCache.set(cacheKey, request);
    return signed;
  }

  async submit(signed: SignedTx): Promise<SubmissionResult> {
    const cacheKey: SignedRequestCacheKey = keccak256(signed.rawTx);
    const request = this.signedRequestCache.get(cacheKey);

    if (!request) {
      throw new Error(
        'ApexTxSubmitter: missing cached ApexTxRequest for signed transaction. ' +
          'Ensure submit() is called with the SignedTx returned by this instance’s sign() method.',
      );
    }

    this.signedRequestCache.delete(cacheKey);
    return this.submitWithRequest(signed, request);
  }

  /**
   * Full submit: private relay first (if configured), public fallback only if
   * the request explicitly allows it.
   *
   * This is the method C1 and C2 engines MUST use.
   */
  async submitWithRequest(
    signed: SignedTx,
    request: ApexTxRequest,
  ): Promise<SubmissionResult> {
    let result: SubmissionResult;

    if (request.privateRelayFirst && this.relaySubmitter) {
      result = await this.relaySubmitter.submit(signed, request);

      if (result.submissionStatus === 'FAILED' && request.publicFallback) {
        // Relay failed — fall back to public RPC
        result = await this.ethersAdapter.submitPublic(signed, request);
      }
    } else if (request.publicFallback) {
      result = await this.ethersAdapter.submitPublic(signed, request);
    } else {
      // Neither relay configured nor public fallback allowed
      result = {
        ...this.buildBaseResult(signed, request),
        submissionStatus: 'FAILED',
        receiptStatus: 'PENDING',
        error: 'No relay configured and public fallback is disabled',
      };
    }

    this.emitLedgerRecord(result, request);
    return result;
  }

  async wait(txHash: string, timeoutMs?: number): Promise<NormalizedReceipt> {
    const timeout = timeoutMs ?? this.receiptTimeoutMs;

    // Try relay receipt poller first (it already knows the fallback RPC)
    if (this.relaySubmitter) {
      return this.relaySubmitter.waitForReceipt(txHash, timeout);
    }
    return this.ethersAdapter.waitForReceipt(txHash, timeout);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private emitLedgerRecord(
    result: SubmissionResult,
    request: ApexTxRequest,
  ): void {
    const ledger: LedgerRecord = {
      opportunityId: request.opportunityId,
      cycleType: request.cycleType,
      cycleId: request.cycleId,
      submitterAdapter: result.submitterAdapter,
      nonce: result.nonce,
      rawTxHash: result.rawTxHash,
      txHash: result.txHash,
      payloadHash: result.payloadHash,
      routeHash: result.routeHash,
      stateHash: result.stateHash,
      configHash: result.configHash,
      configVersion: request.configVersion,
      submissionStatus: result.submissionStatus,
      receiptStatus: result.receiptStatus,
    };
    this.logger.logLedger(request.opportunityId, ledger);
  }

  private buildBaseResult(
    signed: SignedTx,
    request: ApexTxRequest,
  ): Omit<SubmissionResult, 'submissionStatus' | 'receiptStatus'> {
    return {
      opportunityId: request.opportunityId,
      cycleId: request.cycleId,
      cycleType: request.cycleType,
      submitterAdapter: 'ethers_v6',
      nonce: signed.nonce,
      gasLimit: signed.gasLimit.toString(),
      maxFeePerGas: signed.maxFeePerGas.toString(),
      maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
      submittedBlock: 0,
      expiresAtBlock: request.expiresAtBlock,
      txHash: '',
      rawTxHash: '',
      payloadHash: request.payloadHash,
      routeHash: request.routeHash,
      stateHash: request.stateHash,
      configHash: request.configHash,
    };
  }

  private ensureCacheCapacityFor(cacheKey: SignedRequestCacheKey): void {
    if (
      this.signedRequestCache.has(cacheKey) ||
      this.signedRequestCache.size < MAX_CACHED_SIGNED_REQUESTS
    ) {
      return;
    }

    const oldestKey = this.signedRequestCache.keys().next().value;
    if (oldestKey) {
      this.signedRequestCache.delete(oldestKey);
    }
  }
}
