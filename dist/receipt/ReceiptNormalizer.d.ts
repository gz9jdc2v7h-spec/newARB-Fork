/**
 * ReceiptNormalizer — converts any provider receipt (ethers v6 or web3) into
 * the single NormalizedReceipt format used internally by Apex.
 *
 * This is the boundary between the adapter world and the ledger world.
 */
import type { TransactionReceipt as EthersReceipt } from 'ethers';
import type { NormalizedReceipt } from '../types/index.js';
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
export declare class ReceiptNormalizer {
    /** Normalize an ethers v6 TransactionReceipt. */
    static fromEthers(receipt: EthersReceipt): NormalizedReceipt;
    /** Normalize a web3.js receipt. */
    static fromWeb3(receipt: Web3Receipt): NormalizedReceipt;
    /** Generic: try to detect adapter type and normalize accordingly. */
    static normalize(receipt: EthersReceipt | Web3Receipt | Record<string, unknown>): NormalizedReceipt;
}
export {};
//# sourceMappingURL=ReceiptNormalizer.d.ts.map