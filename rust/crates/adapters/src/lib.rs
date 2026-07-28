//! # Adapters
//!
//! DEX invariant adapters.  UniswapV3 and QuickSwap Algebra are kept as
//! **separate models** per Apex-Omega canon:
//!
//! > "Uniswap V3 and QuickSwap Algebra must remain separate models.
//! >  Algebra cannot be forced through the Uniswap V3 ABI path."
//!
//! Each adapter exposes a common [`PoolQuote`] output that feeds the ranking
//! engine without leaking protocol-specific internals upstream.

pub mod algebra;
pub mod univ2;
pub mod univ3;

use serde::{Deserialize, Serialize};

/// Protocol discriminant — never collapsed across types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    UniswapV2,
    SushiSwapV2,
    QuickSwapV2,
    UniswapV3,
    /// QuickSwap Algebra (separate from UniswapV3 — Apex-Omega canon).
    QuickSwapAlgebra,
    /// Any other constant-product V2-compatible AMM.
    GenericV2,
}

/// Direction of a quote relative to the pool's token ordering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SwapDirection {
    /// Selling token0, receiving token1.
    ZeroForOne,
    /// Selling token1, receiving token0.
    OneForZero,
}

/// Normalised quote produced by any adapter.
///
/// All fields use the same unit convention:
/// - amounts are raw token units (not human-normalised)
/// - price is `amountOut_human / amountIn_human` (comparable across pools)
/// - `pool_tvl_usd` is the USD value of both reserves combined
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolQuote {
    /// Chain ID — must be 137 for all valid Polygon candidates.
    pub chain_id: u64,
    /// Protocol type.
    pub protocol: Protocol,
    /// Pool contract address (lower-case hex with 0x prefix).
    pub pool_address: String,
    /// Base token symbol.
    pub base_token: String,
    /// Quote token symbol.
    pub quote_token: String,
    /// Base token contract address.
    pub base_token_address: String,
    /// Quote token contract address.
    pub quote_token_address: String,
    /// Base token decimals.
    pub base_decimals: u8,
    /// Quote token decimals.
    pub quote_decimals: u8,
    /// Amount of base token input used for this quote (raw units).
    pub amount_in_raw: u128,
    /// Amount of quote token output at this price (raw units).
    pub amount_out_raw: u128,
    /// Executable price: `amountOut_human / amountIn_human`.
    /// This is the only value that may rank the leg.
    pub executable_price: f64,
    /// Fee in parts-per-million (e.g. 3000 = 0.3 %).
    pub fee_ppm: u32,
    /// Pool TVL in USD (sum of both reserves at current prices).
    pub pool_tvl_usd: f64,
    /// Unix timestamp (ms) when this quote was obtained.
    pub timestamp_ms: u64,
    /// Raw reserves (UniV2 / Algebra concentrated) — None for pure V3 quotes.
    pub reserve_base_raw: Option<u128>,
    pub reserve_quote_raw: Option<u128>,
    /// sqrtPriceX96 (V3/Algebra) — None for V2 quotes.
    pub sqrt_price_x96: Option<u128>,
    /// Whether this is the best buy or sell quote is determined externally
    /// by the ranking engine.  The adapter never makes this decision.
    pub direction: SwapDirection,
}
