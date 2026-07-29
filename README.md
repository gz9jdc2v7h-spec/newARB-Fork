<div align="center">

# apex-tx-submitter

**Controlled transaction gateway for APEX-OMEGA**

ethers v6 · web3.js adapter · private relay · central nonce manager · normalized receipts · C1/C2 ABI hooks · full execution transparency

</div>

---

## What this is

`apex-tx-submitter` is the **only** module in APEX-OMEGA that may broadcast signed transactions to any chain or relay. Every other component — the scanner, route engine, C1 engine, C2 engine — calls this gateway. None of them touch `ethers.Wallet`, `web3.eth`, or any provider directly.

```
APEX-OMEGA
  ↓
opportunity_engine
  ↓
payload_builder
  ↓
apex-tx-submitter       ← this module
  ↓
private_relay / rpc
  ↓
receipt_normalizer
  ↓
ledger
```

---

## Public surface

Only one interface is the public contract:

```typescript
export interface TxSubmitter {
  build(request: ApexTxRequest): Promise<BuiltTx>;
  sign(request: ApexTxRequest): Promise<SignedTx>;
  submit(signed: SignedTx): Promise<SubmissionResult>;
  wait(txHash: string): Promise<NormalizedReceipt>;
}
```

No other class or function from this module should be referenced in production caller code.

---

## Install

```bash
npm install ethers@^6           # required
npm install web3@^4             # optional — only if using Web3Adapter
```

---

## Quick start

```typescript
import { ApexTxSubmitter, AuditLogger } from 'apex-tx-submitter';

const submitter = new ApexTxSubmitter({
  rpcUrl: 'https://polygon-rpc.com',
  chainId: 137,
  relay: {
    endpoint: 'https://relay.fastlane.finance',
    relayName: 'fastlane',
  },
});

// C1 engine calls:
const signed = await submitter.sign(txRequest);
const result = await submitter.submitWithRequest(signed, txRequest);
const receipt = await submitter.wait(result.txHash);
```

---

## Architecture

### Component map

| File | Role |
|---|---|
| `src/types/index.ts` | All types — `TxSubmitter`, `ApexTxRequest`, `LedgerRecord`, evidence chain types |
| `src/submitter/ApexTxSubmitter.ts` | Main orchestrator — relay first, public fallback, ledger emission |
| `src/nonce/NonceManager.ts` | Central nonce authority — 32-lane collision prevention |
| `src/adapters/EthersV6Adapter.ts` | Primary — signs EIP-1559, polls receipt |
| `src/adapters/Web3Adapter.ts` | Optional — identical interface over web3.js |
| `src/relay/PrivateRelaySubmitter.ts` | Sends raw signed tx to Fastlane / Flashbots / MEV Blocker |
| `src/receipt/ReceiptNormalizer.ts` | One `NormalizedReceipt` shape from any provider |
| `src/pipeline/transparency/AuditLogger.ts` | Stage-by-stage evidence emission |
| `src/pipeline/transparency/EvidenceChain.ts` | Accumulates & hashes the complete opportunity record |
| `src/pipeline/c1/C1Engine.ts` | C1 flash-loan execution hooks |
| `src/pipeline/c2/C2Engine.ts` | C2 MIRROR / REVERSE / NOOP execution hooks |

---

## Execution pipeline transparency

Every opportunity carries seven immutable hash proofs:

| Hash | Proves |
|---|---|
| `config_hash` | Which rule set allowed execution |
| `state_hash` | Which block state was quoted |
| `route_hash` | Which pools and path were used |
| `simulation_hash` | Which calldata survived fork simulation |
| `payload_hash` | What was ABI-encoded |
| `tx_hash` | What was broadcast |
| `settlement_hash` | What the chain confirmed |

Minimum evidence record emitted per opportunity:

```json
{
  "opportunity_id": "opp_...",
  "config_version": 44,
  "config_hash": "0xconfig",
  "state_hash": "0xstate",
  "route_hash": "0xroute",
  "simulation_hash": "0xsim",
  "payload_hash": "0xpayload",
  "tx_hash": "0xtx",
  "settlement_status": "SETTLED",
  "realized_net_usd": "7.99"
}
```

### Profit separation

```
estimated_net_usd  = before fork simulation
simulated_net_usd  = after exact calldata simulation
submitted_net_usd  = expected at submission
realized_net_usd   = after receipt + balance settlement
```

These are **never** mixed in the same field.

### Rejection logging

Every rejected opportunity is logged with equal detail to wins:

```json
{
  "stage": "PROFIT_GATE",
  "status": "REJECTED",
  "reason": "NET_PROFIT_BELOW_MINIMUM",
  "net_profit_usd": "3.41",
  "required_min_net_profit_usd": "5.00",
  "config_version": 44
}
```

Valid rejection reasons: `STATE_TOO_OLD` · `QUOTE_EXPIRED` · `BUY_PRICE_NOT_LOWER_THAN_SELL_PRICE` · `SAME_POOL` · `NET_PROFIT_BELOW_MINIMUM` · `PROFIT_TO_GAS_TOO_LOW` · `SIMULATION_REVERTED` · `REPAYMENT_FAILED` · `PAYLOAD_ABI_MISMATCH` · `PRIVATE_RELAY_REJECTED` · `PUBLIC_FALLBACK_DISABLED` · `KILL_SWITCH_ACTIVE` · `C2_PARENT_NOT_CONFIRMED` · `NONCE_CONFLICT`

---

## C1 / C2 invariants

### C1
- Only targets `initAaveFlash` or `initBalancerFlash`
- Nonce from central `NonceManager` — never self-managed
- Private relay first; public fallback requires explicit config opt-in

### C2
1. **Never** submits before parent C1 receipt confirms
2. Post-C1 state is always reloaded before sizing
3. Must land in blocks `[C1+1, C1+5]`
4. Profit written to a **separate** `c2_cycle` record — never merged with C1
5. NOOP is valid and explicitly logged

### Ledger invariant

Every submission emits:

```json
{
  "opportunity_id": "0x...",
  "cycle_type": "C1 | C2",
  "cycle_id": "0x...",
  "submitter_adapter": "ethers_v6 | web3 | private_relay",
  "nonce": 0,
  "raw_tx_hash": "0x...",
  "tx_hash": "0x...",
  "payload_hash": "0x...",
  "route_hash": "0x...",
  "state_hash": "0x...",
  "config_hash": "0x...",
  "submission_status": "SUBMITTED_PRIVATE | SUBMITTED_PUBLIC | FAILED",
  "receipt_status": "PENDING | CONFIRMED | REVERTED | EXPIRED"
}
```

---

## Minimum validation checklist

- [x] ethers v6 adapter signs raw tx without broadcasting
- [x] web3 adapter signs identical transaction shape
- [x] private relay accepts raw signed tx
- [x] nonce manager prevents 32-lane nonce collision
- [x] receipt normalizer produces one internal receipt format
- [x] C1 ABI path targets `initAaveFlash` / `initBalancerFlash` only
- [x] C2 never submits before parent C1 receipt confirms
- [x] public fallback remains disabled unless config explicitly allows it

---

## Build

```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit (no output)
```

---

## Next logical skill

`apex-ledger-settlement-core` — normalize receipts, reconcile balances, calculate realized PnL, close C1/C2 cycles, and prove settlement truth.

---

## References

- Full architecture memo: [`references/full-memo.md`](./references/full-memo.md)

