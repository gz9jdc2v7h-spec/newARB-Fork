/**
 * PrivateRelaySubmitter — sends a pre-signed raw transaction to a private relay
 * (e.g. Fastlane, Flashbots, MEV Blocker, BloxRoute).
 *
 * The relay expects a JSON-RPC request with method `eth_sendRawTransaction`
 * (or relay-specific variant) and the signed RLP hex as the parameter.
 *
 * This path NEVER falls back to public mempool unless the caller explicitly
 * sets publicFallback = true in the ApexTxRequest.
 */

import { keccak256 } from 'ethers';
import type {
  ApexTxRequest,
  NormalizedReceipt,
  SignedTx,
  SubmissionResult,
} from '../types/index.js';
import { ReceiptNormalizer } from '../receipt/ReceiptNormalizer.js';

/** Relay-provider name → JSON-RPC method (some relays use non-standard names). */
const RELAY_METHODS: Record<string, string> = {
  flashbots:     'eth_sendBundle',          // simplified; real bundles need extra fields
  fastlane:      'eth_sendRawTransaction',
  mevblocker:    'eth_sendRawTransaction',
  bloxroute:     'eth_sendRawTransaction',
  default:       'eth_sendRawTransaction',
};

export interface PrivateRelayConfig {
  /** HTTP(S) endpoint for the relay. */
  endpoint: string;
  /** Relay name key used to look up the RPC method. Default: 'default'. */
  relayName?: string;
  /** Auth header value (e.g. ****** Optional. */
  authHeader?: string;
  /** Request timeout in ms. Default 10_000. */
  timeoutMs?: number;
  /** Receipt poll interval ms. Default 2_000. */
  pollIntervalMs?: number;
  /** Receipt wait timeout ms. Default 120_000. */
  receiptTimeoutMs?: number;
  /** External provider for fetching receipts (relay may not support eth_getTransactionReceipt). */
  rpcFallbackUrl?: string;
}

interface RelayResponse {
  id: number;
  jsonrpc: '2.0';
  result?: string;
  error?: { code: number; message: string };
}

interface RelayRequestPayload {
  method: string;
  params: unknown[];
  txHash: string;
}

export class PrivateRelaySubmitter {
  private readonly endpoint: string;
  private readonly relayName: string;
  private readonly authHeader?: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly receiptTimeoutMs: number;
  private readonly rpcFallbackUrl?: string;

  constructor(config: PrivateRelayConfig) {
    this.endpoint = config.endpoint;
    this.relayName = (config.relayName ?? 'default').toLowerCase();
    this.authHeader = config.authHeader;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.receiptTimeoutMs = config.receiptTimeoutMs ?? 120_000;
    this.rpcFallbackUrl = config.rpcFallbackUrl;
  }

  // ── Submit ────────────────────────────────────────────────────────────────────

  async submit(signed: SignedTx, request: ApexTxRequest): Promise<SubmissionResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authHeader) {
      headers['Authorization'] = this.authHeader;
    }

    let relayResponse: RelayResponse | undefined;
    let relayPayload: RelayRequestPayload | undefined;
    let submittedBlock = 0;

    try {
      relayPayload = this.buildRelayPayload(signed, request);
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: relayPayload.method,
        params: relayPayload.params,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);

      relayResponse = (await res.json()) as RelayResponse;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return this.buildFailedResult(signed, request, `Relay request failed: ${errorMsg}`);
    }

    if (relayResponse.error) {
      return this.buildFailedResult(
        signed,
        request,
        `Relay rejected: [${relayResponse.error.code}] ${relayResponse.error.message}`,
      );
    }

    const txHash = relayPayload?.txHash ?? keccak256(signed.rawTx);

    try {
      submittedBlock = await this.fetchCurrentBlock();
    } catch {
      // Non-fatal: block number used for logging only
    }

    return {
      opportunityId: request.opportunityId,
      cycleId: request.cycleId,
      cycleType: request.cycleType,
      submitterAdapter: 'private_relay',
      relay: this.relayName,
      nonce: signed.nonce,
      gasLimit: signed.gasLimit.toString(),
      maxFeePerGas: signed.maxFeePerGas.toString(),
      maxPriorityFeePerGas: signed.maxPriorityFeePerGas.toString(),
      submittedBlock,
      expiresAtBlock: request.expiresAtBlock,
      txHash,
      rawTxHash: keccak256(signed.rawTx),
      payloadHash: request.payloadHash,
      routeHash: request.routeHash,
      stateHash: request.stateHash,
      configHash: request.configHash,
      submissionStatus: 'SUBMITTED_PRIVATE',
      receiptStatus: 'PENDING',
      relayResponse: JSON.stringify(relayResponse),
    };
  }

  // ── Wait for receipt via fallback RPC ─────────────────────────────────────────

  async waitForReceipt(
    txHash: string,
    timeoutMs?: number,
  ): Promise<NormalizedReceipt> {
    const rpcUrl = this.rpcFallbackUrl ?? this.endpoint;
    const deadline = Date.now() + (timeoutMs ?? this.receiptTimeoutMs);

    while (Date.now() < deadline) {
      const raw = await this.rpcGetReceipt(rpcUrl, txHash);
      if (raw) {
        return ReceiptNormalizer.normalize(raw);
      }
      await sleep(this.pollIntervalMs);
    }

    throw new Error(
      `PrivateRelaySubmitter: receipt timeout for tx ${txHash} after ${timeoutMs ?? this.receiptTimeoutMs}ms`,
    );
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  private async rpcGetReceipt(
    rpcUrl: string,
    txHash: string,
  ): Promise<Record<string, unknown> | null> {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    });
    const json = (await res.json()) as { result?: Record<string, unknown> | null };
    return json.result ?? null;
  }

  private async fetchCurrentBlock(): Promise<number> {
    const rpcUrl = this.rpcFallbackUrl ?? this.endpoint;
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_blockNumber',
        params: [],
      }),
    });
    const json = (await res.json()) as { result?: string };
    return parseInt(json.result ?? '0x0', 16);
  }

  private buildRelayPayload(
    signed: SignedTx,
    request: ApexTxRequest,
  ): RelayRequestPayload {
    const method = RELAY_METHODS[this.relayName] ?? RELAY_METHODS['default'];
    const rawTxHash = keccak256(signed.rawTx);

    if (this.relayName !== 'flashbots') {
      return {
        method,
        params: [signed.rawTx],
        txHash: rawTxHash,
      };
    }

    const targetBlock = request.blockNumber + 1;
    if (request.expiresAtBlock <= targetBlock) {
      throw new Error(
        `Flashbots bundle expires at or before the next block: expiresAtBlock=${request.expiresAtBlock}, nextBlock=${targetBlock}`,
      );
    }

    return {
      method,
      params: [
        {
          txs: [signed.rawTx],
          blockNumber: toRpcQuantity(targetBlock),
          revertingTxHashes: [],
        },
      ],
      txHash: rawTxHash,
    };
  }

  private buildFailedResult(
    signed: SignedTx,
    request: ApexTxRequest,
    errorMsg: string,
  ): SubmissionResult {
    return {
      opportunityId: request.opportunityId,
      cycleId: request.cycleId,
      cycleType: request.cycleType,
      submitterAdapter: 'private_relay',
      relay: this.relayName,
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

function toRpcQuantity(value: number): string {
  return `0x${Math.max(0, Math.trunc(value)).toString(16)}`;
}
