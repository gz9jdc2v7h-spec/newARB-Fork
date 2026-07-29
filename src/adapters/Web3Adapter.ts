/**
 * Web3Adapter — optional web3.js signing/submission adapter.
 *
 * Produces an identical SignedTx and SubmissionResult shape to EthersV6Adapter
 * so the rest of the pipeline is adapter-agnostic.
 *
 * This module is optional: if web3 is not installed the adapter can still be
 * imported but any call to sign() or submitPublic() will throw with a clear
 * "web3 not installed" message rather than a cryptic module error.
 */

import { keccak256 } from 'ethers';
import type {
  ApexTxRequest,
  BuiltTx,
  NormalizedReceipt,
  SignedTx,
  SubmissionResult,
} from '../types/index.js';
import { ReceiptNormalizer } from '../receipt/ReceiptNormalizer.js';
import { NonceManager } from '../nonce/NonceManager.js';

/** Minimal typing for the web3 objects we actually use. */
interface Web3Provider {
  eth: {
    getTransactionCount(address: string, state: string): Promise<bigint>;
    sendSignedTransaction(rawTx: string): {
      on(event: 'transactionHash', cb: (h: string) => void): unknown;
      on(event: 'error', cb: (e: Error) => void): unknown;
    };
    getTransactionReceipt(hash: string): Promise<Record<string, unknown> | null>;
    getBlockNumber(): Promise<bigint>;
  };
  eth_accounts?: {
    signTransaction(tx: Record<string, unknown>, key: string): Promise<{
      rawTransaction: string;
      transactionHash: string;
    }>;
  };
}

// Lazy-load web3 so a missing package gives a helpful error at call time.
let web3Module: { Web3: new (rpc: string) => Web3Provider } | undefined;
async function getWeb3(): Promise<{ Web3: new (rpc: string) => Web3Provider }> {
  if (web3Module) return web3Module;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    web3Module = await import('web3') as any;
    return web3Module!;
  } catch {
    throw new Error(
      'Web3Adapter: web3 package is not installed. ' +
        'Run `npm install web3` or use the EthersV6Adapter instead.',
    );
  }
}

export interface Web3AdapterConfig {
  rpcUrl: string;
  nonceManager: NonceManager;
  chainId: number;
  pollIntervalMs?: number;
  receiptTimeoutMs?: number;
}

export class Web3Adapter {
  private readonly rpcUrl: string;
  private readonly nonceManager: NonceManager;
  private readonly chainId: number;
  private readonly pollIntervalMs: number;
  private readonly receiptTimeoutMs: number;

  constructor(config: Web3AdapterConfig) {
    this.rpcUrl = config.rpcUrl;
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
    const { Web3 } = await getWeb3();
    const web3 = new Web3(this.rpcUrl);

    // Derive signer address from key using ethers (no extra dep needed)
    const { Wallet } = await import('ethers');
    const wallet = new Wallet(request.signerPrivateKey);
    const signerAddress = wallet.address;

    const nonce =
      request.nonce ??
      (await this.nonceManager.acquire(request.chainId, signerAddress));

    const txObject: Record<string, unknown> = {
      chainId: request.chainId,
      nonce,
      to: request.to,
      data: request.data,
      value: (request.value ?? 0n).toString(),
      gas: request.gasLimit.toString(),
      maxFeePerGas: request.maxFeePerGas.toString(),
      maxPriorityFeePerGas: request.maxPriorityFeePerGas.toString(),
      type: '0x2',
    };

    const accounts = (web3 as unknown as Record<string, unknown>).eth as {
      accounts: {
        signTransaction(
          tx: Record<string, unknown>,
          key: string,
        ): Promise<{ rawTransaction: string; transactionHash: string }>;
      };
    };

    const signed = await accounts.accounts.signTransaction(
      txObject,
      request.signerPrivateKey,
    );

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
      rawTx: signed.rawTransaction,
      signerAddress,
    };
  }

  // ── Submit (public RPC) ──────────────────────────────────────────────────────

  async submitPublic(
    signed: SignedTx,
    request: ApexTxRequest,
  ): Promise<SubmissionResult> {
    if (!request.publicFallback) {
      return this.buildFailedResult(signed, request, 'PUBLIC_FALLBACK_DISABLED');
    }

    const { Web3 } = await getWeb3();
    const web3 = new Web3(this.rpcUrl);

    try {
      const txHash = await new Promise<string>((resolve, reject) => {
        const emitter = web3.eth.sendSignedTransaction(signed.rawTx) as unknown as {
          on(event: 'transactionHash', cb: (h: string) => void): void;
          on(event: 'error', cb: (e: Error) => void): void;
        };
        emitter.on('transactionHash', resolve);
        emitter.on('error', reject);
      });

      const blockNum = Number(await web3.eth.getBlockNumber());

      return {
        opportunityId: request.opportunityId,
        cycleId: request.cycleId,
        cycleType: request.cycleType,
        submitterAdapter: 'web3',
        nonce: signed.nonce,
        gasLimit: signed.gasLimit.toString(),
        maxFeePerGas: signed.maxFeePerGas.toString(),
        maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
        submittedBlock: blockNum,
        expiresAtBlock: request.expiresAtBlock,
        txHash,
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
    const { Web3 } = await getWeb3();
    const web3 = new Web3(this.rpcUrl);

    const deadline = Date.now() + (timeoutMs ?? this.receiptTimeoutMs);

    while (Date.now() < deadline) {
      const raw = await web3.eth.getTransactionReceipt(txHash);
      if (raw) {
        return ReceiptNormalizer.fromWeb3(raw as unknown as Parameters<typeof ReceiptNormalizer.fromWeb3>[0]);
      }
      await sleep(this.pollIntervalMs);
    }

    throw new Error(
      `Web3Adapter: receipt timeout for tx ${txHash} after ${timeoutMs ?? this.receiptTimeoutMs}ms`,
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
      submitterAdapter: 'web3',
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
