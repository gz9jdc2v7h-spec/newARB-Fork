/**
 * ReceiptNormalizer — converts any provider receipt (ethers v6 or web3) into
 * the single NormalizedReceipt format used internally by Apex.
 *
 * This is the boundary between the adapter world and the ledger world.
 */

import type { TransactionReceipt as EthersReceipt } from 'ethers';
import type { NormalizedLog, NormalizedReceipt } from '../types/index.js';

/** Shape returned by web3.eth.getTransactionReceipt */
interface Web3Receipt {
  transactionHash: string;
  status: boolean | bigint | string;
  blockNumber: number | bigint | string;
  gasUsed: number | bigint | string;
  effectiveGasPrice?: number | bigint | string;
  from: string;
  to?: string | null;
  contractAddress?: string | null;
  logs: Array<{
    address: string;
    topics: string[];
    data: string;
    logIndex: number | string;
    transactionHash: string;
    blockNumber: number | string;
  }>;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') {
    return value.startsWith('0x') ? BigInt(value) : BigInt(value);
  }
  return 0n;
}

function toNumber(value: unknown): number {
  return Number(toBigInt(value));
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value === 1n;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') return value === '0x1' || value === '1' || value === 'true';
  return false;
}

export class ReceiptNormalizer {
  /** Normalize an ethers v6 TransactionReceipt. */
  static fromEthers(receipt: EthersReceipt): NormalizedReceipt {
    const gasUsed = receipt.gasUsed ?? 0n;
    const effectiveGasPrice = receipt.gasPrice ?? 0n;
    const gasCostWei = gasUsed * effectiveGasPrice;

    const logs: NormalizedLog[] = (receipt.logs ?? []).map((l, i) => ({
      address: l.address,
      topics: [...l.topics],
      data: l.data,
      logIndex: l.index ?? i,
      transactionHash: l.transactionHash ?? receipt.hash,
      blockNumber: l.blockNumber ?? receipt.blockNumber,
    }));

    return {
      txHash: receipt.hash,
      receiptStatus: receipt.status === 1,
      confirmedBlock: receipt.blockNumber,
      gasUsed: gasUsed.toString(),
      effectiveGasPrice: effectiveGasPrice.toString(),
      gasCostWei: gasCostWei.toString(),
      from: receipt.from,
      to: receipt.to ?? '',
      contractAddress: receipt.contractAddress ?? undefined,
      logs,
      rawReceipt: receipt as unknown as Record<string, unknown>,
    };
  }

  /** Normalize a web3.js receipt. */
  static fromWeb3(receipt: Web3Receipt): NormalizedReceipt {
    const gasUsed = toBigInt(receipt.gasUsed);
    const effectiveGasPrice = toBigInt(receipt.effectiveGasPrice ?? 0);
    const gasCostWei = gasUsed * effectiveGasPrice;

    const logs: NormalizedLog[] = (receipt.logs ?? []).map((l) => ({
      address: l.address,
      topics: [...l.topics],
      data: l.data,
      logIndex: toNumber(l.logIndex),
      transactionHash: l.transactionHash,
      blockNumber: toNumber(l.blockNumber),
    }));

    return {
      txHash: receipt.transactionHash,
      receiptStatus: toBoolean(receipt.status),
      confirmedBlock: toNumber(receipt.blockNumber),
      gasUsed: gasUsed.toString(),
      effectiveGasPrice: effectiveGasPrice.toString(),
      gasCostWei: gasCostWei.toString(),
      from: receipt.from,
      to: receipt.to ?? '',
      contractAddress: receipt.contractAddress ?? undefined,
      logs,
      rawReceipt: receipt as unknown as Record<string, unknown>,
    };
  }

  /** Generic: try to detect adapter type and normalize accordingly. */
  static normalize(
    receipt: EthersReceipt | Web3Receipt | Record<string, unknown>,
  ): NormalizedReceipt {
    // ethers v6 receipts carry a `provider` symbol or `hash` field
    if ('hash' in receipt && typeof receipt['hash'] === 'string') {
      return ReceiptNormalizer.fromEthers(receipt as EthersReceipt);
    }
    // web3 receipts carry transactionHash
    if ('transactionHash' in receipt) {
      return ReceiptNormalizer.fromWeb3(receipt as Web3Receipt);
    }
    throw new Error('ReceiptNormalizer: unrecognized receipt shape');
  }
}
