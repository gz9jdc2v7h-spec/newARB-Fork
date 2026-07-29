# apex-tx-submitter — Full Architecture Memo

## Purpose

`apex-tx-submitter` is the controlled transaction gateway for the APEX-OMEGA arbitrage engine.

It is **not** the execution brain. The brain is:

```
state → route → sim → payload → permission → submit → settlement
```

`apex-tx-submitter` owns only the **submit** step plus nonce management and receipt normalization.

---

## Architecture

### Public surface — only this interface

```typescript
export interface TxSubmitter {
  build(request: ApexTxRequest): Promise<BuiltTx>;
  sign(request: ApexTxRequest): Promise<SignedTx>;
  submit(signed: SignedTx): Promise<SubmissionResult>;
  wait(txHash: string): Promise<NormalizedReceipt>;
}
```

No scanner, route engine, C1 engine, or C2 engine should ever call:
- `ethers.Wallet.sendTransaction`
- `web3.eth.sendSignedTransaction`
- `provider.sendTransaction`

They call `TxSubmitter.submit(...)` only.

---

## Integration position

```
APEX-OMEGA
  ↓
opportunity_engine
  ↓
payload_builder
  ↓
apex-tx-submitter        ← this module
  ↓
private_relay / rpc
  ↓
receipt_normalizer
  ↓
ledger
```

---

## Component map

| Component | File | Role |
|---|---|---|
| `TxSubmitter` | `src/types/index.ts` | Only public interface |
| `ApexTxSubmitter` | `src/submitter/ApexTxSubmitter.ts` | Main orchestrator |
| `NonceManager` | `src/nonce/NonceManager.ts` | 32-lane nonce safety |
| `EthersV6Adapter` | `src/adapters/EthersV6Adapter.ts` | ethers v6 primary |
| `Web3Adapter` | `src/adapters/Web3Adapter.ts` | web3 optional adapter |
| `PrivateRelaySubmitter` | `src/relay/PrivateRelaySubmitter.ts` | Raw-tx relay path |
| `ReceiptNormalizer` | `src/receipt/ReceiptNormalizer.ts` | Normalized receipts |
| `AuditLogger` | `src/pipeline/transparency/AuditLogger.ts` | Evidence logger |
| `EvidenceChain` | `src/pipeline/transparency/EvidenceChain.ts` | Per-opportunity hash chain |
| `C1Engine` | `src/pipeline/c1/C1Engine.ts` | C1 execution hooks |
| `C2Engine` | `src/pipeline/c2/C2Engine.ts` | C2 execution hooks |

---

## Evidence hashes

Every opportunity carries seven immutable hashes:

| Hash | What it proves |
|---|---|
| `config_hash` | Which rule set allowed execution |
| `state_hash` | Which block state was quoted from |
| `route_hash` | Which pools and path were selected |
| `simulation_hash` | Which exact calldata survived fork simulation |
| `payload_hash` | What was ABI-encoded and submitted |
| `tx_hash` | What was broadcast |
| `settlement_hash` | What the chain confirmed |

---

## Ledger invariant

Every submission emits:

```json
{
  "opportunity_id": "opp_...",
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

## C1 / C2 invariants

### C1
- Targets `initAaveFlash` or `initBalancerFlash` only
- Nonce acquired from central `NonceManager`
- Private relay first; public fallback only if config explicitly allows

### C2
1. C2 **never** submits before parent C1 receipt confirms
2. Post-C1 state is always reloaded before C2 sizing
3. C2 must land in blocks `[C1+1, C1+5]`
4. C2 profit is written to a separate cycle record — never merged with C1
5. NOOP is a valid and explicitly logged decision

---

## Minimum validation checklist

1. ethers v6 adapter signs raw tx without broadcasting
2. web3 adapter signs identical transaction shape
3. private relay accepts raw signed tx
4. nonce manager prevents 32-lane nonce collision
5. receipt normalizer produces one internal receipt format
6. C1 ABI path targets `initAaveFlash` / `initBalancerFlash` only
7. C2 never submits before parent C1 receipt confirms
8. public fallback remains disabled unless config explicitly allows it

---

## Next logical skill

`apex-ledger-settlement-core`

Purpose: normalize receipts, reconcile balances, calculate realized PnL, close C1/C2 cycles, and prove settlement truth.
