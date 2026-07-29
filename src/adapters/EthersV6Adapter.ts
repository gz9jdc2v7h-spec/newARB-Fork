/**
 * EthersV6Adapter — primary signing and submission adapter using ethers v6.
 *
 * Responsibilities:
 *  - Build a typed EIP-1559 transaction from an ApexTxRequest.
 *  - Sign it locally (never broadcasts from this method).
 *  - Submit directly to an RPC provider (public path, disabled by default).
 *  - Wait for and normalize the receipt.
 */

import {
  JsonRpcProvider,
  Wallet,
  Transaction,
  keccak256,
} from 'ethers';
import type {
  ApexTxRequest,
  BuiltTx,
  NormalizedReceipt,
  SignedTx,
  SubmissionResult,
} from '../types/index.js';
import { ReceiptNormalizer } from '../receipt/ReceiptNormalizer.js';
import { NonceManager } from '../nonce/NonceManager.js';

export interface EthersV6AdapterConfig {
  provider: JsonRpcProvider;
  nonceManager: NonceManager;
  chainId: number;
  /** Receipt poll interval in ms (default 2000). */
  pollIntervalMs?: number;
  /** Max wait for receipt in ms (default 120_000). */
  receiptTimeoutMs?: number;
}

export class EthersV6Adapter {
  private readonly provider: JsonRpcProvider;
  private readonly nonceManager: NonceManager;
  private readonly chainId: number;
  private readonly pollIntervalMs: number;
  private readonly receiptTimeoutMs: number;

  constructor(config: EthersV6AdapterConfig) {
    this.provider = config.provider;
    this.nonceManager = config.nonceManager;
    this.chainId = config.chainId;
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.receiptTimeoutMs = config.receiptTimeoutMs ?? 120_000;
  }

  // ── Build ───────────────────────────────────────────────────────────────────

  async build(request: ApexTxRequest): Promise<BuiltTx> {
    return {
      opportunityId: request.opportunityId,
      cycleId: request.cycleId,
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      chainId: request.chainId,
      payloadHash: request.payloadHash,
    };
  }

  // ── Sign ────────────────────────────────────────────────────────────────────

  async sign(request: ApexTxRequest): Promise<SignedTx> {
    const wallet = new Wallet(request.signerPrivateKey);
    const signerAddress = wallet.address;

    const nonce =
      request.nonce ??
      (await this.nonceManager.acquire(request.chainId, signerAddress));

    const tx = Transaction.from({
      type: 2, // EIP-1559
      chainId: BigInt(request.chainId),
      nonce,
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      gasLimit: request.gasLimit,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    });

    const rawTx = await wallet.signTransaction(tx);

    return {
      opportunityId: request.opportunityId,
      cycleId: request.cycleId,
      to: request.to,
      data: request.data,
      value: request.value ?? 0n,
      chainId: request.chainId,
      payloadHash: request.payloadHash,
      nonce,
      gasLimit: request.gasLimit,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
      rawTx,
      signerAddress,
    };
  }

  // ── Submit (public RPC — only used when public fallback is allowed) ──────────

  async submitPublic(
    signed: SignedTx,
    request: ApexTxRequest,
  ): Promise<SubmissionResult> {
    if (!request.publicFallback) {
      return this.buildFailedResult(signed, request, 'PUBLIC_FALLBACK_DISABLED');
    }

    try {
      const sentTx = await this.provider.broadcastTransaction(signed.rawTx);
      const currentBlock = await this.provider.getBlockNumber();

      return {
        opportunityId: request.opportunityId,
        cycleId: request.cycleId,
        cycleType: request.cycleType,
        submitterAdapter: 'ethers_v6',
        nonce: signed.nonce,
        gasLimit: signed.gasLimit.toString(),
        maxFeePerGas: signed.maxFeePerGas.toString(),
        maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
        submittedBlock: currentBlock,
        expiresAtBlock: request.expiresAtBlock,
        txHash: sentTx.hash,
        rawTxHash: keccak256(signed.rawTx),
        payloadHash: request.payloadHash,
        routeHash: request.routeHash,
        stateHash: request.stateHash,
        configHash: request.configHash,
        submissionStatus: 'SUBMITTED_PUBLIC',
        receiptStatus: 'PENDING',
      };
    } catch (err) {
      return this.buildFailedResult(
        signed,
        request,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── Wait for receipt ─────────────────────────────────────────────────────────

  async waitForReceipt(
    txHash: string,
    timeoutMs?: number,
  ): Promise<NormalizedReceipt> {
    const deadline = Date.now() + (timeoutMs ?? this.receiptTimeoutMs);

    while (Date.now() < deadline) {
      const raw = await this.provider.getTransactionReceipt(txHash);
      if (raw) {
        return ReceiptNormalizer.fromEthers(raw);
      }
      await sleep(this.pollIntervalMs);
    }

    throw new Error(
      `EthersV6Adapter: receipt timeout for tx ${txHash} after ${timeoutMs ?? this.receiptTimeoutMs}ms`,
    );
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  private buildFailedResult(
    signed: SignedTx,
    request: ApexTxRequest,
    errorMsg: string,
  ): SubmissionResult {
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
      rawTxHash: keccak256(signed.rawTx),
      payloadHash: request.payloadHash,
      routeHash: request.routeHash,
      stateHash: request.stateHash,
      configHash: request.configHash,
      submissionStatus: 'FAILED',
      receiptStatus: 'PENDING',
      error: errorMsg,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
