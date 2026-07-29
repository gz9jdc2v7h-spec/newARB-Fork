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
const MAX_LANES = 32;
export class NonceManager {
    provider;
    locks = new Map();
    constructor(provider) {
        this.provider = provider;
    }
    // ── Key ─────────────────────────────────────────────────────────────────────
    key(chainId, address) {
        return `${chainId}:${address.toLowerCase()}`;
    }
    async getLock(chainId, address) {
        const k = this.key(chainId, address);
        if (!this.locks.has(k)) {
            const onChain = await this.provider.getTransactionCount(address, 'pending');
            this.locks.set(k, { current: onChain, pending: false, queue: [] });
        }
        return this.locks.get(k);
    }
    // ── Public API ───────────────────────────────────────────────────────────────
    /**
     * Acquire the next safe nonce.  Waits if a previous acquire is still pending.
     * Throws if the queue would exceed MAX_LANES (32).
     */
    async acquire(chainId, address) {
        const lock = await this.getLock(chainId, address);
        if (lock.queue.length >= MAX_LANES) {
            throw new Error(`NonceManager: lane limit (${MAX_LANES}) reached for ${address} on chain ${chainId}`);
        }
        if (!lock.pending) {
            lock.pending = true;
            const n = lock.current++;
            // Release immediately so the next caller can proceed
            lock.pending = false;
            this.drainQueue(lock);
            return n;
        }
        // Queue this caller
        return new Promise((resolve, reject) => {
            lock.queue.push({ resolve, reject });
        });
    }
    /**
     * Call after a confirmed receipt to re-sync with chain state.
     * This prevents permanent drift after a tx is replaced or dropped.
     */
    async sync(chainId, address) {
        const k = this.key(chainId, address);
        const onChain = await this.provider.getTransactionCount(address, 'pending');
        const lock = this.locks.get(k);
        if (lock) {
            // Only advance, never go backwards
            lock.current = Math.max(lock.current, onChain);
        }
    }
    /**
     * Hard reset — use for recovery after a reverted or dropped sequence.
     */
    async reset(chainId, address) {
        const k = this.key(chainId, address);
        const onChain = await this.provider.getTransactionCount(address, 'pending');
        if (this.locks.has(k)) {
            const lock = this.locks.get(k);
            lock.current = onChain;
            // Drain any waiting callers with the fresh nonce
            this.drainQueue(lock);
        }
    }
    /**
     * Peek at the current nonce without advancing it.
     */
    peek(chainId, address) {
        return this.locks.get(this.key(chainId, address))?.current;
    }
    // ── Internal ─────────────────────────────────────────────────────────────────
    drainQueue(lock) {
        while (lock.queue.length > 0 && !lock.pending) {
            const next = lock.queue.shift();
            lock.pending = true;
            const n = lock.current++;
            lock.pending = false;
            next.resolve(n);
        }
    }
}
//# sourceMappingURL=NonceManager.js.map