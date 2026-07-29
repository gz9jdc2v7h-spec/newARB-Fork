/**
 * NonceManager — central nonce authority for all wallet addresses.
 *
 * Guarantees:
 *  - One nonce lock per (chainId, address) pair.
 *  - 32-lane parallel safety: up to 32 simultaneous callers queue behind a
 *    single mutex without collision.
 *  - On-chain sync on first use and after any confirmed receipt.
 *  - Manual override for recovery scenarios.
 */
import { JsonRpcProvider } from 'ethers';
export declare class NonceManager {
    private readonly provider;
    private readonly locks;
    constructor(provider: JsonRpcProvider);
    private key;
    private getLock;
    /**
     * Acquire the next safe nonce.  Waits if a previous acquire is still pending.
     * Throws if the queue would exceed MAX_LANES (32).
     */
    acquire(chainId: number, address: string): Promise<number>;
    /**
     * Call after a confirmed receipt to re-sync with chain state.
     * This prevents permanent drift after a tx is replaced or dropped.
     */
    sync(chainId: number, address: string): Promise<void>;
    /**
     * Hard reset — use for recovery after a reverted or dropped sequence.
     */
    reset(chainId: number, address: string): Promise<void>;
    /**
     * Peek at the current nonce without advancing it.
     */
    peek(chainId: number, address: string): number | undefined;
    private drainQueue;
}
//# sourceMappingURL=NonceManager.d.ts.map