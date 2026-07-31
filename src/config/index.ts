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
export const ENABLE_BALANCER_QUOTES = optionalEnv("ENABLE_BALANCER_QUOTES", "true") === "true";
export const ENABLE_CURVE_QUOTES = optionalEnv("ENABLE_CURVE_QUOTES", "true") === "true";
export const ENABLE_MULTI_HOP_EXECUTION = optionalEnv("ENABLE_MULTI_HOP_EXECUTION", "false") === "true";
export const ENABLE_MEMPOOL_REPRICING = optionalEnv("ENABLE_MEMPOOL_REPRICING", "false") === "true";
export const ENABLE_PRODUCTION_OBSERVABILITY = optionalEnv("ENABLE_PRODUCTION_OBSERVABILITY", "true") === "true";
export const MAX_PENDING_TX_PER_BLOCK = parseInt(
  optionalEnv("MAX_PENDING_TX_PER_BLOCK", "128"),
  10
);
export const ROUTING_MAX_HOPS = parseInt(optionalEnv("ROUTING_MAX_HOPS", "4"), 10);
export const FLASH_MAX_ROUTE_STEPS = parseInt(optionalEnv("FLASH_MAX_ROUTE_STEPS", "4"), 10);
export const REPRICE_TIMEOUT_MS = parseInt(optionalEnv("REPRICE_TIMEOUT_MS", "15000"), 10);
export const REPRICE_FEE_BUMP_BPS = parseInt(optionalEnv("REPRICE_FEE_BUMP_BPS", "1500"), 10);
export const REPRICE_MAX_ATTEMPTS = parseInt(optionalEnv("REPRICE_MAX_ATTEMPTS", "2"), 10);
export const PUBLIC_FALLBACK = optionalEnv("PUBLIC_FALLBACK", "false") === "true";
export const PRIVATE_RELAY_ENDPOINT = process.env["PRIVATE_RELAY_ENDPOINT"] ?? "";
export const PRIVATE_RELAY_NAME = optionalEnv("PRIVATE_RELAY_NAME", "fastlane");
export const FLASH_EXECUTOR_ADDRESS = process.env["FLASH_EXECUTOR_ADDRESS"] ?? "";
export const FLASH_SIGNER_PRIVATE_KEY = process.env["FLASH_SIGNER_PRIVATE_KEY"] ?? process.env["PRIVATE_KEY"] ?? "";

// ─── Flash Loan ──────────────────────────────────────────────────────────────
export const AAVE_POOL = optionalEnv(
  "AAVE_POOL",
  "0x794a61358D6845594F94dc1DB02A252b5b4814aD"
);

// ─── Token record shape ───────────────────────────────────────────────────────

export interface TokenConfig {
  address: string;
  decimals: number;
  symbol: string;
  /**
   * Tier classification:
   *   0 = base / flash-loan capital
   *   1 = major assets
   *   2 = Polygon-native
   *   3 = stable-pegged
   *   4 = LST / yield
   *   5 = long tail (discovery only)
   */
  tier: 0 | 1 | 2 | 3 | 4 | 5;
}

// ─── Known Tokens (Polygon PoS) ─────────────────────────────────────────────

export const TOKENS: Record<string, TokenConfig> = {

  // ── Tier 0 — Base / Flash-Loan Capital ─────────────────────────────────────

  /** Native Circle USDC (post-2023 Polygon native issuance) */
  USDC: {
    address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    decimals: 6,
    symbol: "USDC",
    tier: 0,
  },
  /** Bridged USDC from Ethereum (formerly "USDC" on Polygon) */
  "USDC.e": {
    address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    decimals: 6,
    symbol: "USDC.e",
    tier: 0,
  },
  USDT: {
    address: "0xc2132D05D31c914a87C6611C10748AaCbA58e8F",
    decimals: 6,
    symbol: "USDT",
    tier: 0,
  },
  DAI: {
    address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    decimals: 18,
    symbol: "DAI",
    tier: 0,
  },
  /** Wrapped POL — rebranded from WMATIC; same contract address */
  WPOL: {
    address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    decimals: 18,
    symbol: "WPOL",
    tier: 0,
  },
  WMATIC: {
    address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    decimals: 18,
    symbol: "WMATIC",
    tier: 0,
  },
  WETH: {
    address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    decimals: 18,
    symbol: "WETH",
    tier: 0,
  },
  WBTC: {
    address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
    decimals: 8,
    symbol: "WBTC",
    tier: 0,
  },

  // ── Tier 1 — Major Assets ──────────────────────────────────────────────────

  LINK: {
    address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39",
    decimals: 18,
    symbol: "LINK",
    tier: 1,
  },
  AAVE: {
    address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
    decimals: 18,
    symbol: "AAVE",
    tier: 1,
  },
  UNI: {
    address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
    decimals: 18,
    symbol: "UNI",
    tier: 1,
  },
  SUSHI: {
    address: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a",
    decimals: 18,
    symbol: "SUSHI",
    tier: 1,
  },
  /** QuickSwap governance token (new QUICK) */
  QUICK: {
    address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17",
    decimals: 18,
    symbol: "QUICK",
    tier: 1,
  },
  BAL: {
    address: "0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A7",
    decimals: 18,
    symbol: "BAL",
    tier: 1,
  },
  CRV: {
    address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
    decimals: 18,
    symbol: "CRV",
    tier: 1,
  },
  MKR: {
    address: "0x6f7C932e7684666C9fd1d44527765433e01fF61d",
    decimals: 18,
    symbol: "MKR",
    tier: 1,
  },
  COMP: {
    address: "0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c",
    decimals: 18,
    symbol: "COMP",
    tier: 1,
  },
  SNX: {
    address: "0x50B728D8D964fd00C2d0AAD81718b71311feF68a",
    decimals: 18,
    symbol: "SNX",
    tier: 1,
  },
  LDO: {
    address: "0xC3C7d422809852031b44ab29EEC9F1EfF2A58756",
    decimals: 18,
    symbol: "LDO",
    tier: 1,
  },
  "1INCH": {
    address: "0x9c2C5fd7b07E95EE044DDeba0E97a665F142394d",
    decimals: 18,
    symbol: "1INCH",
    tier: 1,
  },

  // ── Tier 2 — Polygon Native ────────────────────────────────────────────────

  GHST: {
    address: "0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7",
    decimals: 18,
    symbol: "GHST",
    tier: 2,
  },
  GNS: {
    address: "0xE5417Af564e4bFDA1c483642db72007871397896",
    decimals: 18,
    symbol: "GNS",
    tier: 2,
  },
  TEL: {
    address: "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32",
    decimals: 2,
    symbol: "TEL",
    tier: 2,
  },
  QI: {
    address: "0x580A84C73811E1839F75d86d75d88cCa0c241fF4",
    decimals: 18,
    symbol: "QI",
    tier: 2,
  },
  DFYN: {
    address: "0xC168E40227E4ebD8C1caE80F7a55a4F0e6D66C97",
    decimals: 18,
    symbol: "DFYN",
    tier: 2,
  },
  DODO: {
    address: "0xe4Bf2864ebeC7B7fDf6Eeca9BaCAe7cDfDAffe78",
    decimals: 18,
    symbol: "DODO",
    tier: 2,
  },
  ORBS: {
    address: "0x614389EaAE0A6821DC49062D56BDA3d9d45Fa2ff",
    decimals: 18,
    symbol: "ORBS",
    tier: 2,
  },
  TRADE: {
    address: "0x692AC1e363ae34b6B489148152b12e2785a3d8d6",
    decimals: 18,
    symbol: "TRADE",
    tier: 2,
  },
  NAKA: {
    address: "0x311434160D7537be358930def317AfB606C0D737",
    decimals: 18,
    symbol: "NAKA",
    tier: 2,
  },
  VOXEL: {
    address: "0xd0258a3fD00f38aa8090dfee343f10A9D4d30D3F",
    decimals: 18,
    symbol: "VOXEL",
    tier: 2,
  },
  SAND: {
    address: "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683",
    decimals: 18,
    symbol: "SAND",
    tier: 2,
  },
  MANA: {
    address: "0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4",
    decimals: 18,
    symbol: "MANA",
    tier: 2,
  },
  GRT: {
    address: "0x5fe2B58c013d7601147DcdD68C143A77499f5531",
    decimals: 18,
    symbol: "GRT",
    tier: 2,
  },
  RNDR: {
    address: "0x61299774020dA444Af134c82fa83E3810b309991",
    decimals: 18,
    symbol: "RNDR",
    tier: 2,
  },
  ANKR: {
    address: "0x101A023270368c0D50BFfb62780F4aFd4ea79C35",
    decimals: 18,
    symbol: "ANKR",
    tier: 2,
  },
  FIS: {
    address: "0x7A7B94F18EF6AD056CDa648588181CDA84800f94",
    decimals: 18,
    symbol: "FIS",
    tier: 2,
  },

  // ── Tier 3 — Stable Pegged ─────────────────────────────────────────────────

  FRAX: {
    address: "0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89",
    decimals: 18,
    symbol: "FRAX",
    tier: 3,
  },
  /** MAI / miMATIC — Mai Finance stablecoin */
  MAI: {
    address: "0xa3Fa99A148fA48D14Ed51d610c367C61876997F1",
    decimals: 18,
    symbol: "MAI",
    tier: 3,
  },
  TUSD: {
    address: "0x2e1AD108fF1D138DDb3F1D7F1B2dcC6F33f1f57A",
    decimals: 18,
    symbol: "TUSD",
    tier: 3,
  },
  /** Angle Protocol agEUR */
  agEUR: {
    address: "0xE0B52e49357Fd4DAf2c15e02058DCE6BC0057db4",
    decimals: 18,
    symbol: "agEUR",
    tier: 3,
  },
  /** Jarvis Network jEUR */
  jEUR: {
    address: "0x4e3Decbb3645551B8A19f0eA1678079FCB33fB4c",
    decimals: 18,
    symbol: "jEUR",
    tier: 3,
  },
  /** Monerium EURe */
  EURe: {
    address: "0x18ec0A6E18E5bc3784fDd3a3634b31245ab704F6",
    decimals: 18,
    symbol: "EURe",
    tier: 3,
  },
  /** AgEur v2 / EURO3 */
  EURO3: {
    address: "0xA0e4c84693266a9d3BBef2f394B33712c76599Ab",
    decimals: 18,
    symbol: "EURO3",
    tier: 3,
  },
  /** STASIS EURS — 2 decimals */
  EURS: {
    address: "0xE111178A87A3BFf0c8d18DECBa5798827539Ae99",
    decimals: 2,
    symbol: "EURS",
    tier: 3,
  },
  /** Pegasus USD */
  pUSD: {
    address: "0x6d3cC56DFC016151eE2613BdddE14B24cC3f7dA6",
    decimals: 18,
    symbol: "pUSD",
    tier: 3,
  },

  // ── Tier 4 — LST / Yield ───────────────────────────────────────────────────

  /** Lido stMATIC — liquid staking token */
  stMATIC: {
    address: "0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4",
    decimals: 18,
    symbol: "stMATIC",
    tier: 4,
  },
  /** Stader MaticX */
  MaticX: {
    address: "0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6",
    decimals: 18,
    symbol: "MaticX",
    tier: 4,
  },
  /** Lido wrapped stETH (bridged to Polygon) */
  wstETH: {
    address: "0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD",
    decimals: 18,
    symbol: "wstETH",
    tier: 4,
  },
  /** Aave v2 Polygon aUSDC */
  amUSDC: {
    address: "0x1a13F4Ca1d028320A707D99520AbFefca3998b7F",
    decimals: 6,
    symbol: "amUSDC",
    tier: 4,
  },
  /** Aave v2 Polygon aUSDT */
  amUSDT: {
    address: "0x60D55F02A771d515e077c9C2403a1ef324885CeC",
    decimals: 6,
    symbol: "amUSDT",
    tier: 4,
  },
  /** Aave v2 Polygon aDAI */
  amDAI: {
    address: "0x27F8D03b3a2196956ED754baDc28D73be8830A6e",
    decimals: 18,
    symbol: "amDAI",
    tier: 4,
  },
  /** Aave v2 Polygon aWETH */
  amWETH: {
    address: "0x28424507fefb6f7f8E9D3860F56504E4e5f5f390",
    decimals: 18,
    symbol: "amWETH",
    tier: 4,
  },
  /** Aave v2 Polygon aWBTC */
  amWBTC: {
    address: "0x5c2ed810328349100A66B82b78a1791B101C9D61",
    decimals: 8,
    symbol: "amWBTC",
    tier: 4,
  },
  /** Balancer boosted Aave USD LP token */
  "bb-a-USD": {
    address: "0xf93579002DBE8046c43FEfE86ec78b1112247BB8",
    decimals: 18,
    symbol: "bb-a-USD",
    tier: 4,
  },

  // ── Tier 5 — Long Tail (Discovery Only) ───────────────────────────────────

  /** Beefy Finance vault token */
  BIFI: {
    address: "0xFbdd194376de19a88118e84E279b977f440d8E3e",
    decimals: 18,
    symbol: "BIFI",
    tier: 5,
  },
  /** KlimaDAO — 9 decimals */
  KLIMA: {
    address: "0x4e78011Ce80ee02d2c3e649Fb657E45898257815",
    decimals: 9,
    symbol: "KLIMA",
    tier: 5,
  },
  /** SportX SX */
  SX: {
    address: "0x840195888Db4D6A99ED9F73FcD3B225Bb3cB1A79",
    decimals: 18,
    symbol: "SX",
    tier: 5,
  },
  /** Angle Protocol ANGLE */
  ANGLE: {
    address: "0x900F717EA076E1E7a484ad9DD2dB81CEEc60eBF1",
    decimals: 18,
    symbol: "ANGLE",
    tier: 5,
  },
  /** Frax Share */
  FXS: {
    address: "0x1a3acf6D19267E2d3e7f898f42803e90C9219062",
    decimals: 18,
    symbol: "FXS",
    tier: 5,
  },
  /** ApeSwap BANANA */
  BANANA: {
    address: "0x5d47bAbA0d66083C52009271faF3F50DCc01023C",
    decimals: 18,
    symbol: "BANANA",
    tier: 5,
  },
  /** Iron Finance ICE */
  ICE: {
    address: "0x4A81f8796e0c6Ad4877A51C86693B0dE8093F2ef",
    decimals: 18,
    symbol: "ICE",
    tier: 5,
  },
  /** Dogelon Mars ELON */
  ELON: {
    address: "0xE0339c80fFDE91F3e20494Df88d4206D86024cdF",
    decimals: 18,
    symbol: "ELON",
    tier: 5,
  },
  /** Polycat FISH */
  FISH: {
    address: "0x3a3dF212b7AA91Aa0402B9035b098891d276572B",
    decimals: 18,
    symbol: "FISH",
    tier: 5,
  },
  /** FireBird Finance FIRE */
  FIRE: {
    address: "0x38Cf11283DE05cF1823b7804bC75068bd06f3FD6",
    decimals: 18,
    symbol: "FIRE",
    tier: 5,
  },
  /** ElkFinance ELK */
  ELK: {
    address: "0xeEeEEb57642040bE42185f49C52F7E9B38f8eeeE",
    decimals: 18,
    symbol: "ELK",
    tier: 5,
  },
  /** WaultFinance WEXPOLY */
  WEXPOLY: {
    address: "0x4c4BF319237D98a30A929A96112EfFa8DA3510EB",
    decimals: 18,
    symbol: "WEXPOLY",
    tier: 5,
  },
  /** Tetu Finance TETU */
  TETU: {
    address: "0x255707B70BF90aa112006E1b07B9AeA6De021424",
    decimals: 18,
    symbol: "TETU",
    tier: 5,
  },
  /** Retro Finance RETRO */
  RETRO: {
    address: "0xBFA35599c7AEbb0dAcE9b5aa3ca5f2a79624D8Eb",
    decimals: 18,
    symbol: "RETRO",
    tier: 5,
  },
  /** Meshswap MESH */
  MESH: {
    address: "0x82362Ec182Db3Cf7ad01330A2e8A7c0f4B2a1A3",
    decimals: 18,
    symbol: "MESH",
    tier: 5,
  },
  /** Furucombo COMBO */
  COMBO: {
    address: "0x6DdB31002abC64e1479Fc439692F7eA061e78165",
    decimals: 18,
    symbol: "COMBO",
    tier: 5,
  },
};

// ─── Tier groupings (exported for routing and flash-loan selection) ───────────

/** Symbols of all Tier-0 base assets (flash-loan capital / primary routing). */
export const BASE_ASSETS: readonly string[] = Object.entries(TOKENS)
  .filter(([, cfg]) => cfg.tier === 0)
  .map(([sym]) => sym);

/** Tier-1 major cross-chain assets. */
export const TIER1_TOKENS: readonly string[] = Object.entries(TOKENS)
  .filter(([, cfg]) => cfg.tier === 1)
  .map(([sym]) => sym);

/** Tier-2 Polygon-native assets. */
export const TIER2_TOKENS: readonly string[] = Object.entries(TOKENS)
  .filter(([, cfg]) => cfg.tier === 2)
  .map(([sym]) => sym);

/** Tier-3 stable-pegged assets. */
export const TIER3_TOKENS: readonly string[] = Object.entries(TOKENS)
  .filter(([, cfg]) => cfg.tier === 3)
  .map(([sym]) => sym);

/** Tier-4 LST / yield-bearing assets. */
export const TIER4_TOKENS: readonly string[] = Object.entries(TOKENS)
  .filter(([, cfg]) => cfg.tier === 4)
  .map(([sym]) => sym);

/** Tier-5 long-tail tokens (discovery only). */
export const TIER5_TOKENS: readonly string[] = Object.entries(TOKENS)
  .filter(([, cfg]) => cfg.tier === 5)
  .map(([sym]) => sym);

// ─── DEX Definitions ─────────────────────────────────────────────────────────

export interface DexConfig {
  name: string;
  type: "UniV2" | "UniV3" | "Balancer" | "Curve";
  factory?: string;       // UniV2 / UniV3
  quoter?: string;        // UniV3
  router?: string;
  vault?: string;         // Balancer
  feeTiers?: number[];    // UniV3 (in bps * 100, e.g. 3000 = 0.3%)
  defaultFee?: number;    // UniV2 fee (e.g. 3000 = 0.3%)
  /** Balancer V2: known pool IDs to query. Token symbols must match TOKENS keys. */
  pools?: Array<{ poolId: string; tokens: string[] }>;
}

export interface BalancerPoolConfig {
  poolId: string;
  tokenIn: string;
  tokenOut: string;
  swapFeeBps?: number;
  enabled?: boolean;
}

export interface CurvePoolConfig {
  name: string;
  pool: string;
  tokenSymbols: string[];
  tokenAddresses: string[];
}

function parseJsonEnv<T>(key: string, fallback: T): T {
  const raw = process.env[key];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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
    pools: [
      // WMATIC / WETH 80/20 weighted
      {
        poolId: "0x0297e37f1873d2dab4487aa67cd56b58e2f27875000200000000000000000002",
        tokens: ["WMATIC", "WETH"],
      },
      // WBTC / WETH 50/50 weighted
      {
        poolId: "0xfeadd389a5c427952d8fdb8057d6c8ba1156cc56000200000000000000000049",
        tokens: ["WBTC", "WETH"],
      },
      // WMATIC / USDC / WETH 3-token weighted (pool 0x03cd…)
      {
        poolId: "0x03cd191f589d12b0582a99808cf19851e468e6b500010000000000000000000a",
        tokens: ["WMATIC", "USDC", "WETH"],
      },
      // USDC / DAI / USDT ComposableStableSwap
      {
        poolId: "0x06df3b2bbb68adc8b0e468d33c17349c2c87b84e000000000000000000000012",
        tokens: ["USDC", "DAI", "USDT"],
      },
    ],
  },
  {
    name: "Curve",
    type: "Curve",
    router: "0x0000000000000000000000000000000000000000",
  },
];

export const BALANCER_POOLS: BalancerPoolConfig[] = parseJsonEnv<BalancerPoolConfig[]>(
  "BALANCER_POOLS",
  []
).filter((pool) => (pool.enabled ?? true) && Boolean(pool.poolId));

export const CURVE_POOLS: CurvePoolConfig[] = parseJsonEnv<CurvePoolConfig[]>(
  "CURVE_POOLS",
  []
).filter(
  (pool) =>
    Boolean(pool.pool) &&
    Array.isArray(pool.tokenSymbols) &&
    Array.isArray(pool.tokenAddresses) &&
    pool.tokenSymbols.length >= 2 &&
    pool.tokenSymbols.length === pool.tokenAddresses.length
);

// Pairs to monitor (base token → quote tokens)
export const SCAN_PAIRS: Array<[string, string]> = [
  // ── Tier 0 × Tier 0 ────────────────────────────────────────────────────────
  ["USDC",   "USDC.e"],  // native vs bridged stablecoin arb
  ["WMATIC", "USDC"],
  ["WMATIC", "USDC.e"],
  ["WMATIC", "USDT"],
  ["WMATIC", "WETH"],
  ["WETH",   "USDC"],
  ["WETH",   "USDC.e"],
  ["WETH",   "USDT"],
  ["WETH",   "DAI"],
  ["WBTC",   "WETH"],
  ["WBTC",   "USDC"],
  ["WBTC",   "USDC.e"],
  ["USDC",   "USDT"],
  ["USDC",   "DAI"],
  ["USDT",   "DAI"],
  ["USDC.e", "USDT"],
  ["USDC.e", "DAI"],

  // ── Tier 1 × base ──────────────────────────────────────────────────────────
  ["LINK",   "WETH"],
  ["LINK",   "USDC"],
  ["AAVE",   "WETH"],
  ["AAVE",   "USDC"],
  ["UNI",    "WETH"],
  ["UNI",    "USDC"],
  ["SUSHI",  "WETH"],
  ["SUSHI",  "USDC"],
  ["QUICK",  "WETH"],
  ["QUICK",  "USDC"],
  ["QUICK",  "WMATIC"],
  ["BAL",    "WETH"],
  ["BAL",    "USDC"],
  ["CRV",    "WETH"],
  ["CRV",    "USDC"],
  ["MKR",    "WETH"],
  ["COMP",   "WETH"],
  ["COMP",   "USDC"],
  ["SNX",    "WETH"],
  ["SNX",    "USDC"],
  ["LDO",    "WETH"],
  ["1INCH",  "WETH"],
  ["1INCH",  "USDC"],

  // ── Tier 2 × base ──────────────────────────────────────────────────────────
  ["GHST",   "WETH"],
  ["GHST",   "USDC"],
  ["GHST",   "WMATIC"],
  ["GNS",    "WETH"],
  ["GNS",    "USDC"],
  ["TEL",    "WMATIC"],
  ["QI",     "WMATIC"],
  ["QI",     "USDC"],
  ["DFYN",   "WETH"],
  ["DODO",   "WETH"],
  ["ORBS",   "WMATIC"],
  ["VOXEL",  "WETH"],
  ["VOXEL",  "USDC"],
  ["SAND",   "WETH"],
  ["SAND",   "USDC"],
  ["MANA",   "WETH"],
  ["MANA",   "USDC"],
  ["GRT",    "WETH"],
  ["GRT",    "USDC"],
  ["RNDR",   "WETH"],
  ["RNDR",   "USDC"],
  ["ANKR",   "WETH"],
  ["FIS",    "WETH"],

  // ── Tier 3 × stables ───────────────────────────────────────────────────────
  ["FRAX",   "USDC"],
  ["FRAX",   "USDC.e"],
  ["FRAX",   "USDT"],
  ["FRAX",   "DAI"],
  ["FRAX",   "WETH"],
  ["MAI",    "USDC"],
  ["MAI",    "USDC.e"],
  ["MAI",    "USDT"],
  ["MAI",    "DAI"],
  ["MAI",    "WETH"],
  ["TUSD",   "USDC"],
  ["TUSD",   "USDT"],
  ["agEUR",  "USDC"],
  ["agEUR",  "WETH"],
  ["jEUR",   "USDC"],
  ["EURe",   "USDC"],
  ["EURS",   "USDC"],

  // ── Tier 4 × base ──────────────────────────────────────────────────────────
  ["stMATIC", "WMATIC"],
  ["stMATIC", "USDC"],
  ["MaticX",  "WMATIC"],
  ["MaticX",  "USDC"],
  ["wstETH",  "WETH"],
  ["wstETH",  "USDC"],

  // ── Tier 5 × base (discovery only) ─────────────────────────────────────────
  ["BIFI",    "WETH"],
  ["KLIMA",   "USDC"],
  ["KLIMA",   "WMATIC"],
  ["FXS",     "USDC"],
  ["FXS",     "WETH"],
  ["ANGLE",   "USDC"],
  ["BANANA",  "WMATIC"],
  ["ELK",     "WMATIC"],
  ["TETU",    "USDC"],
  ["TETU",    "WMATIC"],
  ["RETRO",   "WMATIC"],
  ["RETRO",   "USDC"],
  ["MESH",    "WMATIC"],
  ["MESH",    "USDC"],
  ["SX",      "WETH"],
];
