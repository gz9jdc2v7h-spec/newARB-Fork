<div align="center">

# newARB-Fork

## Polygon arbitrage system for discovery, ranking, execution, and evidence-driven profitability review

**Live-scan architecture:** Discovery · Ranking · Execution · Auditability  
**Primary runtime:** TypeScript / ethers v6  
**Validation surfaces:** Dry-run runner, Python scanner tests, build/typecheck pipeline

</div>

---

## Executive summary

`newARB-Fork` is a Polygon PoS arbitrage system built to:

1. **discover** cross-DEX price dislocations in real time,
2. **rank** them with exact or conservative profit math,
3. **execute** qualifying trades with slippage and gas controls, and
4. **record enough evidence** to review what was found, why it ranked highly, and whether it was actually worth trading.

The repository contains more than a simple spread scanner. It includes:

- bounded-concurrency quote collection,
- adaptive spread filtering,
- exact CFMM profit evaluation,
- Kelly-style risk-adjusted scoring,
- Bellman-Ford cycle detection for multi-hop awareness,
- portfolio selection under capital constraints,
- sequential swap execution with approvals and retries,
- circuit-breaker protection,
- controlled transaction submission infrastructure,
- receipt normalization and execution evidence hooks,
- dry-run reporting for discovery/ranking metrics, and
- test coverage for scanner and math behavior in the Python validation layer.

This README is intentionally precise: it describes what the repository can **actually do today**, what it can **measure today**, and what must still be validated in forked or live conditions before anyone treats projected profit as realized return.

---

## What this system is designed to prove

The codebase is built to prove, measure, or expose the following classes of metrics:

| Area | What can be measured or evidenced |
|---|---|
| **Discovery** | pairs scanned, quotes fetched, DEX coverage, worker concurrency, block-driven scan cadence, quote failures |
| **Ranking** | spread, optimal input sizing, gross profit, gas cost, net profit, price impact, Kelly score, multi-hop signal |
| **Execution readiness** | route selection, slippage floors, approvals, gas caps, retry outcomes, circuit-breaker state |
| **Operational safety** | network verification, RPC failover, dry-run mode, nonce coordination, private-relay pathing |
| **Profitability review** | per-opportunity expected net profit, capital deployed, potential ROI, cycle-level best route, average top-1 net profit |
| **Settlement evidence** | receipts, normalized logs, submission records, stage hashes, C1/C2 execution hooks |

What it does **not** honestly prove by itself is guaranteed future profit. Profitability depends on live liquidity, latency, failed-leg risk, market movement between legs, gas conditions, approvals, and settlement quality.

---

## Repository capability map

```text
src/
├── adapters/      ethers v6 / web3 transaction adapters
├── config/        chain, RPC, token, DEX, and execution parameters
├── discovery/     quote acquisition and scan orchestration
├── execution/     live two-leg trade execution
├── math/          CFMM math, Bellman-Ford, Kelly, EMA, portfolio selection
├── nonce/         nonce coordination
├── pipeline/      C1/C2 execution, transparency, evidence hooks
├── ranking/       gas estimation and opportunity ranking
├── receipt/       receipt normalization
├── relay/         private relay submission path
├── submitter/     controlled transaction submission gateway
├── types/         shared interfaces
├── utils/         logging and helpers
├── dryrun.ts      25-cycle live-endpoint discovery/ranking runner
└── index.ts       main runtime bootstrap

python/
└── tests/         scanner + math validation suite

rust/
└── crates/        scanner/ranking/validator support crates and PyO3 wrapper
```

---

## Core system capabilities

### 1. Discovery engine

The discovery layer is responsible for building a fresh market snapshot across configured pairs and exchanges.

**Implemented capabilities**

- Scans all configured `(DEX, pair)` combinations in parallel.
- Uses a bounded worker pool via `DISCOVERY_WORKERS` to avoid uncontrolled RPC fan-out.
- Supports **WebSocket block subscriptions** when available.
- Falls back to **HTTP polling** when WebSocket endpoints are unavailable.
- Verifies the connected network is **Polygon PoS (chain 137)** before operating.
- Logs quote failures without crashing the overall scan cycle.
- Emits a pair-grouped snapshot to the ranking layer.

**Current configured discovery universe**

- **DEXes with active quote paths described in this README**
  - Uniswap V3
  - SushiSwap V2
  - QuickSwap V2
- **DEX configured in the repo but not yet presented here as a fully active quote path**
  - Balancer V2
- **Tokens**
  - WMATIC
  - WETH
  - USDC
  - USDT
  - DAI
  - WBTC
- **Configured pair list**
  - WMATIC/USDC
  - WMATIC/USDT
  - WMATIC/WETH
  - WETH/USDC
  - WETH/USDT
  - WETH/DAI
  - WBTC/WETH
  - USDC/USDT
  - WBTC/USDC

**Discovery math and data sources**

- **UniV2-style venues** use reserve-based quote logic.
- **UniV3** uses quoter-based pricing.
- **Balancer V2** is wired into configuration and capability reporting, with quote support signaled as not yet complete.

**Discovery metrics exposed by the code**

- number of pairs scanned,
- number of quotes fetched,
- quote failures,
- snapshot size,
- cycle count,
- best route per cycle,
- average top-ranked performance over a dry-run session.

### 2. Ranking engine

The ranking layer converts raw quotes into trade candidates and scores them by expected quality rather than raw spread alone.

**Implemented capabilities**

- Derives token USD prices from live snapshot data.
- Estimates gas cost in USD using EIP-1559 fee data.
- Detects profitable two-DEX directions by identifying the lower-priced buy side and higher-priced sell side.
- Applies adaptive spread filtering using EMA-derived thresholds.
- Rejects opportunities below the configured `MIN_PROFIT_USD`.
- Sorts opportunities by **Kelly-adjusted score**.
- Flags opportunities that are part of a detected **multi-hop cycle**.

**Profit and ranking inputs**

- quoted executable prices,
- pool reserves when available,
- fee basis points,
- exact or re-quoted output amounts,
- estimated gas units,
- ETH/USD derived from snapshot,
- token/USD derived from stablecoin or WETH links,
- measured or inferred price impact,
- volatility regime from EMA statistics.

### 3. Exact trade sizing and profit estimation

The system does not rely on spread alone. It includes explicit trade sizing and profit computation logic.

**Implemented capabilities**

- Closed-form optimal input sizing for compatible UniV2/CFMM reserve sets.
- Exact BigInt constant-product profit math when both legs expose reserves.
- Re-quotation at actual trade size when a UniV3 leg is involved.
- Separate gross and net profit accounting.
- Capital deployment tracking in USD.

**Profitability metrics produced per opportunity**

| Metric | Meaning |
|---|---|
| `grossProfitUsd` | expected gross profit before gas |
| `gasCostUsd` | expected gas cost translated to USD |
| `netProfitUsd` | gross minus gas |
| `tradeAmountInUsd` | actual deployed input capital in USD |
| `score` | Kelly-adjusted risk score |
| `priceImpactBuy` | buy-leg impact estimate |
| `priceImpactSell` | sell-leg impact estimate |
| `isMultiHop` | whether the pair participates in a detected cycle |

### 4. Multi-hop and portfolio intelligence

The codebase contains ranking extensions beyond simple top-1 selection.

**Multi-hop detection**

- Models the quote universe as a directed graph.
- Uses **Bellman-Ford** negative-cycle detection.
- Converts detected cycles into a signal that can boost ranking confidence.

**Portfolio selection**

- Includes a quantum-inspired simulated annealing selector.
- Solves a capital-budget allocation problem over ranked opportunities.
- Supports selecting a portfolio instead of blindly trading only the first candidate.

### 5. Execution engine

When `PRIVATE_KEY` is present, the runtime can progress from ranked opportunity to live transaction flow.

**Implemented capabilities**

- Creates an executor only in live mode.
- Performs token approval checks before swap submission.
- Executes venue-specific swap methods for UniV2 or UniV3 paths.
- Uses `amountOutMinimum` derived from `MAX_SLIPPAGE`.
- Executes a **two-leg sequential round trip**:
  1. sell on the higher-priced venue,
  2. buy back on the lower-priced venue.
- Parses receipt logs to recover actual intermediate output before leg 2.
- Retries failed execution steps with helper-based retry logic.
- Uses EIP-1559 fee parameters on submitted transactions.

**Execution controls**

- dry-run mode when `PRIVATE_KEY` is absent,
- maximum gas price cap,
- minimum profit threshold,
- slippage floor,
- retry wrapper,
- graceful shutdown handling.

### 6. Circuit-breaker and operational safety

The live executor includes a simple but important operational guardrail.

**Implemented behavior**

- tracks consecutive failures,
- opens after **3 consecutive failures**,
- pauses further execution while open,
- retries after a **30-second cool-down**.

This protects the system from repeatedly forcing live trades into unstable conditions.

### 7. Controlled submission infrastructure

The repository also includes a more formal transaction-submission architecture for controlled execution paths.

**Included capabilities**

- `TxSubmitter` interface for build → sign → submit → wait lifecycle,
- `ApexTxSubmitter` orchestration,
- `NonceManager` for central nonce coordination,
- ethers v6 and web3 adapters,
- private relay submission support,
- receipt normalization,
- audit and evidence logging hooks,
- C1/C2 pipeline hooks for staged execution models.

This means the repository is not only a scanner/executor; it also contains infrastructure for a stronger execution-control and observability model.

---

## Discovery, ranking, and profitability logic in plain language

### Discovery

For each configured pair, the bot asks each configured DEX for the best current executable quote it can derive. Those quotes are grouped into a snapshot.

### Ranking

For each pair with at least two usable quotes, the bot:

1. identifies the cheaper venue and the richer venue,
2. measures spread,
3. computes an optimal or conservative trade size,
4. computes exact or re-quoted gross profit for that size,
5. estimates gas in USD,
6. filters out low-net-profit candidates,
7. computes a risk-adjusted Kelly score, and
8. sorts the resulting opportunities descending by score.

### Execution

If live mode is enabled, the top-ranked opportunity can be executed as:

1. first swap into the richer side,
2. read actual received output,
3. swap back through the cheaper side,
4. observe receipts and update failure or success state.

### Profitability review

The system therefore produces four distinct profitability views:

- **spread profitability**: raw pricing difference,
- **trade-size profitability**: whether size-adjusted execution remains positive,
- **gas-adjusted profitability**: whether the route still clears the minimum threshold after fees,
- **risk-adjusted attractiveness**: whether the opportunity still scores well after Kelly-style risk treatment.

---

## Tests and validation surfaces

This repository has several ways to validate discovery, ranking, and execution-readiness behavior.

### 1. Python scanner test suite

The Python test suite validates the fallback scanner/math layer and gives concrete evidence for discovery and ranking primitives.

**Covered behaviors**

- integer square root behavior,
- CFMM amount-out calculations,
- CFMM optimal input behavior,
- arbitrage profit behavior for identical and shifted pools,
- candidate generation,
- wrong-chain rejection,
- low-TVL rejection,
- zero-price rejection,
- same-pool rejection,
- candidate sorting by spread,
- summary counter correctness,
- best-candidate selection semantics,
- raw quote type compatibility.

These tests do not prove live profitability, but they do prove that core discovery and candidate-filtering logic behaves deterministically under controlled inputs.

### 2. TypeScript build and type validation

The TypeScript runtime exposes standard validation entry points:

```bash
npm run build
npm run typecheck
```

These prove the repository still compiles and that the public runtime paths remain type-consistent.

### 3. Live dry-run validation

The dry-run runner is the strongest built-in evidence surface for real discovery and ranking metrics without broadcasting trades.

```bash
npm run dryrun
```

**What dry-run reports**

- 25 live scan/rank cycles,
- current block number when available,
- top 10 ranked routes per cycle,
- gross profit,
- gas cost,
- net profit,
- capital size,
- buy/sell price impact,
- Kelly score,
- multi-hop marker,
- cycle summary counts,
- final aggregate summary across all cycles.

**Final dry-run summary metrics**

- total profitable routes across all cycles,
- best net-profit route seen,
- best Kelly-score route seen,
- average top-1 net profit per cycle.

This is the best built-in mechanism for documenting discovery quality and ranking output under live endpoint conditions without taking settlement risk.

### 4. Live execution validation

When a wallet is configured, execution validation moves from hypothetical to operational:

- approvals must succeed,
- first-leg execution must settle,
- actual intermediate output must be recoverable from logs,
- second-leg execution must settle,
- circuit-breaker logic must remain healthy,
- receipts and audit hooks can be used to compare expected versus realized outcomes.

This is the layer where projected opportunity quality becomes real settlement evidence.

---

## Profitability, executable edge, and potential ROI

### What the code can estimate

For every ranked opportunity, the system can estimate:

- how much capital would be deployed,
- how much gross profit the route implies at that size,
- how much gas should cost,
- what net profit remains after gas,
- what price impact each leg introduces,
- whether the route is strong enough to clear configured thresholds,
- how attractive it is on a risk-adjusted basis.

### Practical ROI formula

A practical first-pass ROI metric from the current data model is:

```text
Expected ROI per opportunity = netProfitUsd / tradeAmountInUsd
```

This is useful for comparing opportunities with different capital requirements.

### What must be true for ROI to be real

Expected ROI becomes realized ROI only if:

1. the quotes are still valid when the transactions land,
2. the first leg settles near expected output,
3. the second leg settles near expected output,
4. gas does not materially exceed the model,
5. no approval, nonce, RPC, or sequencing issue breaks the round trip,
6. slippage remains within configured tolerances,
7. there is no adverse market move between the two legs.

### Honest interpretation of profitability claims

This repository can **rank potentially profitable opportunities** and can **execute qualifying opportunities**. It can also produce evidence that a route looked profitable at discovery time.

It does **not** guarantee:

- stable future profitability,
- guaranteed positive realized PnL,
- guaranteed ROI persistence across market regimes,
- immunity from latency, MEV, partial failure, or market movement.

That distinction matters. A professional deployment should treat:

- **dry-run metrics** as evidence of discovery quality,
- **fork tests** as evidence of execution-path correctness,
- **live receipts and ledger records** as evidence of realized profitability.

---

## Capability breakdown by layer

| Layer | Present in repo | Practical value |
|---|---|---|
| Discovery scanning | Yes | finds cross-venue dislocations |
| DEX-specific quoting | Yes | makes prices executable rather than purely theoretical |
| CFMM trade sizing | Yes | prevents naïve over-sizing |
| Gas-adjusted ranking | Yes | filters out fake profit |
| Kelly scoring | Yes | ranks on risk-adjusted attractiveness |
| Multi-hop cycle awareness | Yes | detects broader structural edge |
| Portfolio optimization | Yes | supports capital-efficient multi-trade selection |
| Live execution path | Yes | can act on ranked opportunities |
| Circuit breaker | Yes | limits repeated damage during instability |
| Nonce / submitter infrastructure | Yes | supports controlled submission workflows |
| Evidence / audit hooks | Yes | supports post-trade review and traceability |
| Built-in live dry-run | Yes | validates live discovery/ranking without trading |
| Formal TypeScript unit tests | Not present in package scripts today | build/typecheck remain the primary TS validation surface |

---

## Operating modes

### Dry-run mode

If `PRIVATE_KEY` is omitted:

- discovery runs,
- ranking runs,
- execution is disabled,
- no live swaps are submitted.

This is the safest default for proving that the system is seeing and ranking opportunities.

### Live mode

If `PRIVATE_KEY` is set:

- the executor is initialized,
- top-ranked opportunities can be traded,
- approvals and swaps are broadcast,
- failure counts affect the circuit breaker.

---

## Quick start

### Install

```bash
npm install
```

### Configure

```bash
cp .env.example .env
```

Set at minimum:

- `POLYGON_RPC_HTTP`
- `POLYGON_RPC_WS` (optional but preferred)
- `PRIVATE_KEY` for live execution only

### Development run

```bash
npm run dev
```

### Dry-run validation

```bash
npm run dryrun
```

### Build production bundle

```bash
npm run build
npm start
```

### Python validation

```bash
python -m pytest python/tests/test_scanner.py
```

---

## Configuration reference

| Variable | Default / status | Role |
|---|---|---|
| `POLYGON_RPC_HTTP` | `https://polygon-rpc.com` | primary HTTP RPC |
| `POLYGON_RPC_HTTP_FALLBACK` | `https://polygon-bor-rpc.publicnode.com` | fallback HTTP RPC |
| `POLYGON_RPC_WS` | optional | preferred WebSocket RPC |
| `POLYGON_RPC_WS_FALLBACK` | optional | fallback WebSocket RPC |
| `POLYGON_RPC_HTTP_CANDIDATES` | built-in list | HTTP endpoint probe sequence |
| `POLYGON_RPC_WS_CANDIDATES` | built-in list | WebSocket endpoint probe sequence |
| `PRIVATE_KEY` | none | enables live execution |
| `MIN_PROFIT_USD` | `5.0` | minimum net-profit gate |
| `MAX_GAS_PRICE_GWEI` | `2.0` | gas ceiling |
| `MAX_SLIPPAGE` | `0.005` | slippage tolerance |
| `DISCOVERY_WORKERS` | `8` | bounded scan concurrency |
| `POLL_INTERVAL_MS` | `500` | polling interval when needed |
| `LOG_LEVEL` | `info` | runtime log verbosity |
| `AAVE_POOL` | Polygon Aave pool address | flash-loan path configuration |

The config layer also accepts legacy `ARB_*` RPC aliases for HTTP/WS compatibility paths.

---

## Security and operating notes

- Never commit `.env` or private keys.
- Use a dedicated low-balance wallet for live execution.
- Validate live routes on a fork before trusting mainnet capital.
- Treat projected net profit as a model output until settlement proves it.
- Review receipt logs and evidence records for every executed route.
- Keep gas caps conservative; fake edge disappears quickly when gas expands.
- Respect the circuit breaker instead of force-running through repeated failures.

---

## Bottom line

`newARB-Fork` already contains a substantial system for:

- **discovering** actionable price dislocations,
- **ranking** them with executable profit math,
- **executing** them with venue-aware swap logic,
- **measuring** expected net profitability and potential ROI,
- and **reviewing** those outcomes with structured operational evidence.

Its strongest built-in proof points today are:

1. deterministic scanner and math tests,
2. successful TypeScript build/type validation,
3. 25-cycle live dry-run metric output,
4. execution-path controls for moving from ranked opportunity to live settlement.

That makes this repository well suited for serious arbitrage research and controlled deployment, provided projected profit is always distinguished from realized profit.
