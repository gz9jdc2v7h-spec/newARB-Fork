import "dotenv/config";
import { ethers } from "ethers";

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

function csvEnv(key: string, defaultValue: string[]): string[] {
  const raw = process.env[key];
  if (!raw) return defaultValue;
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

// ─── Network ────────────────────────────────────────────────────────────────
export const CHAIN_ID = 137; // Polygon PoS

export const RPC_HTTP = optionalEnv(
  "POLYGON_RPC_HTTP",
  optionalEnv("ARB_RPC_HTTP", "https://polygon-rpc.com")
);
export const RPC_HTTP_FALLBACK = optionalEnv(
  "POLYGON_RPC_HTTP_FALLBACK",
  optionalEnv("ARB_RPC_HTTP_FALLBACK", "https://polygon-bor-rpc.publicnode.com")
);
export const RPC_WS = process.env["POLYGON_RPC_WS"] ?? process.env["ARB_RPC_WS"];
export const RPC_WS_FALLBACK = process.env["POLYGON_RPC_WS_FALLBACK"];

export const RPC_HTTP_CANDIDATES = csvEnv("POLYGON_RPC_HTTP_CANDIDATES", [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon-rpc.com",
  "https://rpc.ankr.com/polygon",
  "https://polygon.llamarpc.com",
  RPC_HTTP,
  RPC_HTTP_FALLBACK,
]).filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i);

export const RPC_WS_CANDIDATES = csvEnv("POLYGON_RPC_WS_CANDIDATES", [
  "wss://polygon-bor-rpc.publicnode.com",
  "wss://polygon-heimdall-rpc.publicnode.com:443/websocket",
  RPC_WS ?? "",
  RPC_WS_FALLBACK ?? "",
]).filter((v, i, arr) => v.length > 0 && arr.indexOf(v) === i);

// ─── Wallet ──────────────────────────────────────────────────────────────────
export function getWallet(provider: ethers.Provider): ethers.Wallet {
  const pk = requireEnv("PRIVATE_KEY");
  return new ethers.Wallet(pk, provider);
}

// ─── Bot Parameters ──────────────────────────────────────────────────────────
export const MIN_PROFIT_USD = parseFloat(
  optionalEnv("MIN_PROFIT_USD", "5.0")
);
export const MAX_GAS_PRICE_GWEI = parseFloat(
  optionalEnv("MAX_GAS_PRICE_GWEI", "2.0")
);
export const MAX_SLIPPAGE = parseFloat(optionalEnv("MAX_SLIPPAGE", "0.005"));
export const DISCOVERY_WORKERS = parseInt(
  optionalEnv("DISCOVERY_WORKERS", "8"),
  10
);
export const POLL_INTERVAL_MS = parseInt(
  optionalEnv("POLL_INTERVAL_MS", "500"),
  10
);
export const LOG_LEVEL = optionalEnv("LOG_LEVEL", "info");
export const ENABLE_PENDING_FEED = optionalEnv("ENABLE_PENDING_FEED", "true") === "true";
export const MARKET_EVENT_BUFFER_SIZE = parseInt(
  optionalEnv("MARKET_EVENT_BUFFER_SIZE", "512"),
  10
);
export const QUOTE_MAX_AGE_MS = parseInt(
  optionalEnv("QUOTE_MAX_AGE_MS", "4000"),
  10
);
export const ENABLE_ATOMIC_FLASH = optionalEnv("ENABLE_ATOMIC_FLASH", "false") === "true";
export const ENABLE_PRIVATE_RELAY = optionalEnv("ENABLE_PRIVATE_RELAY", "false") === "true";
export const MAX_PENDING_TX_PER_BLOCK = parseInt(
  optionalEnv("MAX_PENDING_TX_PER_BLOCK", "128"),
  10
);

// ─── Flash Loan ──────────────────────────────────────────────────────────────
export const AAVE_POOL = optionalEnv(
  "AAVE_POOL",
  "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
);

// ─── Known Tokens (Polygon PoS) ─────────────────────────────────────────────
export const TOKENS: Record<string, { address: string; decimals: number; symbol: string }> =
  {
    WMATIC: {
      address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
      decimals: 18,
      symbol: "WMATIC",
    },
    WETH: {
      address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
      decimals: 18,
      symbol: "WETH",
    },
    USDC: {
      address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      decimals: 6,
      symbol: "USDC",
    },
    USDT: {
      address: "0xc2132D05D31c914a87C6611C10748AaCbA58e8F",
      decimals: 6,
      symbol: "USDT",
    },
    DAI: {
      address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
      decimals: 18,
      symbol: "DAI",
    },
    WBTC: {
      address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
      decimals: 8,
      symbol: "WBTC",
    },
  };

// ─── DEX Definitions ─────────────────────────────────────────────────────────

export interface DexConfig {
  name: string;
  type: "UniV2" | "UniV3" | "Balancer";
  factory?: string;       // UniV2 / UniV3
  quoter?: string;        // UniV3
  router: string;
  vault?: string;         // Balancer
  feeTiers?: number[];    // UniV3 (in bps * 100, e.g. 3000 = 0.3%)
  defaultFee?: number;    // UniV2 fee (e.g. 3000 = 0.3%)
}

export const DEXES: DexConfig[] = [
  // Uniswap V3
  {
    name: "UniswapV3",
    type: "UniV3",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e", // QuoterV2
    router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    feeTiers: [100, 500, 3000, 10000],
  },
  // SushiSwap V2
  {
    name: "SushiSwapV2",
    type: "UniV2",
    factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
    router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    defaultFee: 3000,
  },
  // QuickSwap V2
  {
    name: "QuickSwapV2",
    type: "UniV2",
    factory: "0x5757371414417b8c6caad45baef941abc7d3ab32",
    router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    defaultFee: 3000,
  },
  // Balancer V2
  {
    name: "BalancerV2",
    type: "Balancer",
    vault: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
    router: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
  },
];

// Pairs to monitor (base token → quote tokens)
export const SCAN_PAIRS: Array<[string, string]> = [
  ["WMATIC", "USDC"],
  ["WMATIC", "USDT"],
  ["WMATIC", "WETH"],
  ["WETH", "USDC"],
  ["WETH", "USDT"],
  ["WETH", "DAI"],
  ["WBTC", "WETH"],
  ["USDC", "USDT"],
  ["WBTC", "USDC"],
];
