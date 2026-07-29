//! UniswapV3 adapter — factory/quoter model (Uniswap V3 ABI).
//!
//! Uses `sqrtPriceX96` from the pool slot0 and the V3 Quoter for exact quotes.
//! **Must not be confused with or merged into the Algebra adapter.**

use rust_math::{sqrt_price_x96_to_price, v3_approximate_amount_out};
use serde::{Deserialize, Serialize};

use crate::{PoolQuote, Protocol, SwapDirection};

/// V3 pool slot0 data (as returned by `IUniswapV3Pool.slot0()`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V3Slot0 {
    pub sqrt_price_x96: u128,
    pub tick: i32,
    pub observation_index: u16,
    pub observation_cardinality: u16,
    pub fee_protocol: u8,
    pub unlocked: bool,
}

/// V3 pool liquidity context needed for quote computation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniV3PoolContext {
    pub chain_id: u64,
    pub pool_address: String,
    pub token0_address: String,
    pub token1_address: String,
    pub token0_symbol: String,
    pub token1_symbol: String,
    pub token0_decimals: u8,
    pub token1_decimals: u8,
    /// Fee tier in ppm (100 / 500 / 3000 / 10000).
    pub fee_ppm: u32,
    pub slot0: V3Slot0,
    /// Total value locked in USD.
    pub tvl_usd: f64,
    pub timestamp_ms: u64,
}

impl UniV3PoolContext {
    /// Produce an approximate [`PoolQuote`] for `base_token → quote_token`
    /// using the current `sqrtPriceX96`.
    ///
    /// **This is a first-order approximation only.**  For the gate decision
    /// the on-chain V3 quoter must be called to get an exact quote.
    pub fn approximate_quote(
        &self,
        base_symbol: &str,
        base_address: &str,
        quote_symbol: &str,
        _quote_address: &str,
        amount_in_raw: u128,
    ) -> PoolQuote {
        let token_in_is_token0 = base_address.to_lowercase() == self.token0_address.to_lowercase();
        let (decimals_in, decimals_out) = if token_in_is_token0 {
            (self.token0_decimals, self.token1_decimals)
        } else {
            (self.token1_decimals, self.token0_decimals)
        };

        let amount_out_f = v3_approximate_amount_out(
            amount_in_raw,
            self.slot0.sqrt_price_x96,
            self.fee_ppm,
            decimals_in,
            decimals_out,
            token_in_is_token0,
        );
        let amount_in_f = amount_in_raw as f64 / 10f64.powi(decimals_in as i32);
        let executable_price = if amount_in_f > 0.0 { amount_out_f / amount_in_f } else { 0.0 };
        let amount_out_raw = (amount_out_f * 10f64.powi(decimals_out as i32)) as u128;

        let direction = if token_in_is_token0 {
            SwapDirection::ZeroForOne
        } else {
            SwapDirection::OneForZero
        };

        PoolQuote {
            chain_id: self.chain_id,
            protocol: Protocol::UniswapV3,
            pool_address: self.pool_address.clone(),
            base_token: base_symbol.to_string(),
            quote_token: quote_symbol.to_string(),
            base_token_address: base_address.to_string(),
            quote_token_address: _quote_address.to_string(),
            base_decimals: decimals_in,
            quote_decimals: decimals_out,
            amount_in_raw,
            amount_out_raw,
            executable_price,
            fee_ppm: self.fee_ppm,
            pool_tvl_usd: self.tvl_usd,
            timestamp_ms: self.timestamp_ms,
            reserve_base_raw: None,
            reserve_quote_raw: None,
            sqrt_price_x96: Some(self.slot0.sqrt_price_x96),
            direction,
        }
    }

    /// Derive the spot price for display (not for leg selection).
    pub fn spot_price_token0_in_token1(&self) -> f64 {
        sqrt_price_x96_to_price(
            self.slot0.sqrt_price_x96,
            self.token0_decimals,
            self.token1_decimals,
            true,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_context() -> UniV3PoolContext {
        UniV3PoolContext {
            chain_id: 42161,
            pool_address: "0xABCD".to_string(),
            token0_address: "0x0000".to_string(),
            token1_address: "0x0001".to_string(),
            token0_symbol: "WETH".to_string(),
            token1_symbol: "USDC".to_string(),
            token0_decimals: 18,
            token1_decimals: 6,
            fee_ppm: 3000,
            slot0: V3Slot0 {
                // sqrtPriceX96 for WETH ≈ $0.80 relative to USDC scale: sqrt(0.80e12) × 2^96
                sqrt_price_x96: 56_022_770_974_786_143_748_341_760,
                tick: -3_000,
                observation_index: 0,
                observation_cardinality: 1,
                fee_protocol: 0,
                unlocked: true,
            },
            tvl_usd: 500_000.0,
            timestamp_ms: 0,
        }
    }

    #[test]
    fn test_approximate_quote_returns_nonzero() {
        let ctx = make_context();
        let quote = ctx.approximate_quote(
            "WETH", "0x0000",
            "USDC", "0x0001",
            1_000_000_000_000_000_000u128, // 1 WETH (18 dec)
        );
        assert!(quote.executable_price > 0.0, "expected positive price, got {}", quote.executable_price);
        assert_eq!(quote.protocol, Protocol::UniswapV3);
        assert_eq!(quote.chain_id, 42161);
    }

    #[test]
    fn test_spot_price_nonzero() {
        let ctx = make_context();
        let price = ctx.spot_price_token0_in_token1();
        assert!(price > 0.0, "expected non-zero spot price");
    }
}
