<div align="center">

# apex-tx-submitter

  <h1>newARB-Fork — Arbitrum Arbitrage Bot</h1>

  <p>Optimised for live mainnet operations: Discovery · Ranking · Execution</p>

</div>

---

## Overview

`newARB-Fork` is a TypeScript arbitrage bot targeting **Arbitrum One (chain 42161)**.  
It watches multiple DEXes simultaneously, ranks cross-DEX price discrepancies by expected net profit, and executes the most profitable trades with EIP-1559 gas optimisation.

### Architecture

```
src/
├── config/         – Network config, token list, DEX addresses, env vars
├── discovery/
│   ├── abis.ts             – Minimal ABIs for UniV2, UniV3, Aave
│   ├── PriceFeeder.ts      – Per-DEX quote fetchers (UniV2 reserve math, UniV3 QuoterV2)
│   └── OpportunityScanner.ts – Parallel pair scanner + WebSocket/HTTP-poll event loop
├── ranking/
│   ├── GasEstimator.ts     – EIP-1559 gas data with 1-second cache
│   └── OpportunityRanker.ts – Profit scoring with slippage & gas deduction
├── execution/
│   └── Executor.ts         – Two-leg sequential swap, ERC-20 approval, circuit breaker
├── utils/
│   ├── logger.ts           – Structured ISO-timestamp logger
│   └── helpers.ts          – pLimit, withRetry, sleep, unit conversions
└── index.ts        – Bootstrap: provider, scanner, ranker, executor
```

### Key features

| Feature | Detail |
|---|---|
| **Multi-DEX discovery** | Uniswap V3, Camelot V3, SushiSwap V2, Camelot V2, Balancer V2 |
| **Bounded concurrency** | Configurable worker pool (`DISCOVERY_WORKERS`) for RPC calls |
| **WebSocket subscriptions** | Block-event driven scanning; falls back to HTTP polling |
| **EIP-1559 gas optimisation** | Dynamic `maxFeePerGas` capped by `MAX_GAS_PRICE_GWEI` |
| **Opportunity ranking** | Net profit = gross − gas; sorted by profit-to-gas score |
| **Slippage guard** | `amountOutMinimum` = quoted × (1 − `MAX_SLIPPAGE`) |
| **Retry logic** | Exponential back-off on RPC / execution errors |
| **Circuit breaker** | Auto-pauses execution after 3 consecutive failures (30 s cool-down) |
| **Dry-run mode** | Omit `PRIVATE_KEY` to run discovery + ranking without executing |

---

## Quick Start

### 1. Install

```bash
npm install
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env and set at minimum:
# ARB_RPC_HTTP  — your Arbitrum HTTP RPC endpoint
# ARB_RPC_WS    — (optional) WebSocket endpoint for lower latency
# PRIVATE_KEY   — executor wallet private key (omit for dry-run)
```

### 3. Run (development)

```bash
npm run dev
```

### 4. Build & run (production)

```bash
npm run build
npm start
```

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `ARB_RPC_HTTP` | public Arbitrum RPC | Primary HTTP endpoint |
| `ARB_RPC_HTTP_FALLBACK` | publicnode.com | Fallback HTTP endpoint |
| `ARB_RPC_WS` | _(none)_ | WebSocket endpoint for block subscriptions |
| `PRIVATE_KEY` | _(none)_ | Executor wallet — omit for dry-run |
| `MIN_PROFIT_USD` | `5.0` | Minimum net profit to execute (USD) |
| `MAX_GAS_PRICE_GWEI` | `2.0` | Maximum gas price willing to pay (Gwei) |
| `MAX_SLIPPAGE` | `0.005` | Slippage tolerance (0.5 %) |
| `DISCOVERY_WORKERS` | `8` | Parallel RPC workers for price scanning |
| `POLL_INTERVAL_MS` | `500` | HTTP poll interval (ms) when WebSocket unavailable |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug` / `info` / `warn` / `error`) |

---

## Supported DEXes (Arbitrum One)

| DEX | Type | Notes |
|---|---|---|
| Uniswap V3 | UniV3 | Fee tiers: 0.01 %, 0.05 %, 0.3 %, 1 % |
| Camelot V3 | UniV3 | Algebra dynamic-fee pools |
| SushiSwap V2 | UniV2 | 0.3 % fee |
| Camelot V2 | UniV2 | 0.3 % fee |
| Balancer V2 | Balancer | Vault-based (quote support coming) |

---

## Security Notes

- **Never commit `.env`** — it is in `.gitignore`.
- Run with a dedicated low-balance wallet; only fund it with what you need.
- Test on a forked mainnet (e.g. Hardhat or Foundry Anvil `--fork-url`) before using real funds.

