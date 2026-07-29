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

// ─── Network ────────────────────────────────────────────────────────────────
export const CHAIN_ID = 42161; // Arbitrum One

export const RPC_HTTP = optionalEnv(
  "ARB_RPC_HTTP",
  "https://arb1.arbitrum.io/rpc"
);
export const RPC_HTTP_FALLBACK = optionalEnv(
  "ARB_RPC_HTTP_FALLBACK",
  "https://arbitrum-one.publicnode.com"
);
export const RPC_WS = process.env["ARB_RPC_WS"];

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

// ─── Flash Loan ──────────────────────────────────────────────────────────────
export const AAVE_POOL = optionalEnv(
  "AAVE_POOL",
  "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
);

// ─── Known Tokens (Arbitrum One) ─────────────────────────────────────────────
export const TOKENS: Record<string, { address: string; decimals: number; symbol: string }> =
  {
    WETH: {
      address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      decimals: 18,
      symbol: "WETH",
    },
    USDC: {
      address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
      decimals: 6,
      symbol: "USDC",
    },
    USDT: {
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      decimals: 6,
      symbol: "USDT",
    },
    DAI: {
      address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      decimals: 18,
      symbol: "DAI",
    },
    WBTC: {
      address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
      decimals: 8,
      symbol: "WBTC",
    },
    ARB: {
      address: "0x912CE59144191C1204E64559FE8253a0e49E6548",
      decimals: 18,
      symbol: "ARB",
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
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    feeTiers: [100, 500, 3000, 10000],
  },
  // Camelot V3 (Algebra-based, single dynamic fee pool)
  {
    name: "CamelotV3",
    type: "UniV3",
    factory: "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35b",
    quoter: "0xa6EF4d6a2E48E2dD2e23f2BB72F53e15B12E22D6",
    router: "0x1F721E2E82F6676FCE4eA07A5958cF098D339e18",
    feeTiers: [0], // dynamic fee — placeholder
  },
  // SushiSwap V2
  {
    name: "SushiSwapV2",
    type: "UniV2",
    factory: "0xc35DADB65012eC5796536bD9864eD8773aBc74C4",
    router: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
    defaultFee: 3000,
  },
  // Camelot V2
  {
    name: "CamelotV2",
    type: "UniV2",
    factory: "0x6EcCab422D763aC031210895C81787E87B43A652",
    router: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d",
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
  ["WETH", "USDC"],
  ["WETH", "USDT"],
  ["WETH", "DAI"],
  ["WBTC", "WETH"],
  ["USDC", "USDT"],
  ["ARB", "WETH"],
  ["ARB", "USDC"],
];
