//! UniswapV2-compatible adapter (SushiSwap V2, QuickSwap V2, GenericV2).
//!
//! Uses exact constant-product reserves for all calculations.

use rust_math::{cfmm_amount_out, cfmm_spot_price};
use serde::{Deserialize, Serialize};

use crate::{PoolQuote, Protocol, SwapDirection};

/// V2 pool reserve snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniV2PoolContext {
    pub chain_id: u64,
    pub protocol: Protocol,
    pub pool_address: String,
    pub token0_address: String,
    pub token1_address: String,
    pub token0_symbol: String,
    pub token1_symbol: String,
    pub token0_decimals: u8,
    pub token1_decimals: u8,
    /// Fee in ppm (e.g. 3000 = 0.3 %, 2500 = 0.25 %).
    pub fee_ppm: u32,
    /// Raw reserve of token0.
    pub reserve0: u128,
    /// Raw reserve of token1.
    pub reserve1: u128,
    pub tvl_usd: f64,
    pub timestamp_ms: u64,
}

impl UniV2PoolContext {
    /// Produce an exact [`PoolQuote`] using on-chain reserve arithmetic.
    pub fn quote(
        &self,
        base_symbol: &str,
        base_address: &str,
        quote_symbol: &str,
        quote_address: &str,
        amount_in_raw: u128,
    ) -> PoolQuote {
        let token_in_is_token0 = base_address.to_lowercase() == self.token0_address.to_lowercase();
        let (reserve_in, reserve_out, decimals_in, decimals_out) = if token_in_is_token0 {
            (self.reserve0, self.reserve1, self.token0_decimals, self.token1_decimals)
        } else {
            (self.reserve1, self.reserve0, self.token1_decimals, self.token0_decimals)
        };
        let fee_bps = self.fee_ppm / 100;
        let amount_out_raw = cfmm_amount_out(reserve_in, reserve_out, amount_in_raw, fee_bps);
        let amount_in_f = amount_in_raw as f64 / 10f64.powi(decimals_in as i32);
        let amount_out_f = amount_out_raw as f64 / 10f64.powi(decimals_out as i32);
        let executable_price = if amount_in_f > 0.0 { amount_out_f / amount_in_f } else { 0.0 };

        let (reserve_base_raw, reserve_quote_raw) = if token_in_is_token0 {
            (Some(self.reserve0), Some(self.reserve1))
        } else {
            (Some(self.reserve1), Some(self.reserve0))
        };
        let direction = if token_in_is_token0 {
            SwapDirection::ZeroForOne
        } else {
            SwapDirection::OneForZero
        };

        PoolQuote {
            chain_id: self.chain_id,
            protocol: self.protocol,
            pool_address: self.pool_address.clone(),
            base_token: base_symbol.to_string(),
            quote_token: quote_symbol.to_string(),
            base_token_address: base_address.to_string(),
            quote_token_address: quote_address.to_string(),
            base_decimals: decimals_in,
            quote_decimals: decimals_out,
            amount_in_raw,
            amount_out_raw,
            executable_price,
            fee_ppm: self.fee_ppm,
            pool_tvl_usd: self.tvl_usd,
            timestamp_ms: self.timestamp_ms,
            reserve_base_raw,
            reserve_quote_raw,
            sqrt_price_x96: None,
            direction,
        }
    }

    /// Spot price: `reserveOut / reserveIn` normalised for decimals.
    pub fn spot_price(&self, token_in_is_token0: bool) -> f64 {
        let (r_in, r_out, dec_in, dec_out) = if token_in_is_token0 {
            (self.reserve0, self.reserve1, self.token0_decimals, self.token1_decimals)
        } else {
            (self.reserve1, self.reserve0, self.token1_decimals, self.token0_decimals)
        };
        cfmm_spot_price(r_in, r_out, dec_in, dec_out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_context() -> UniV2PoolContext {
        UniV2PoolContext {
            chain_id: 137,
            protocol: Protocol::QuickSwapV2,
            pool_address: "0xQS".to_string(),
            token0_address: "0x0000".to_string(),
            token1_address: "0x0001".to_string(),
            token0_symbol: "WMATIC".to_string(),
            token1_symbol: "USDC".to_string(),
            token0_decimals: 18,
            token1_decimals: 6,
            fee_ppm: 3000,
            reserve0: 10_000_000_000_000_000_000_000u128, // 10000 WMATIC
            reserve1: 8_000_000_000u128,                  // 8000 USDC (6 dec)
            tvl_usd: 16_000.0,
            timestamp_ms: 0,
        }
    }

    #[test]
    fn test_univ2_quote_price() {
        let ctx = make_context();
        let quote = ctx.quote(
            "WMATIC", "0x0000",
            "USDC",   "0x0001",
            1_000_000_000_000_000_000u128, // 1 WMATIC
        );
        // Price ≈ 8000/10000 = 0.8 USDC per WMATIC (minus fee)
        assert!(quote.executable_price > 0.7 && quote.executable_price < 0.9,
            "expected ~0.8, got {}", quote.executable_price);
        assert_eq!(quote.protocol, Protocol::QuickSwapV2);
    }

    #[test]
    fn test_univ2_reserves_preserved() {
        let ctx = make_context();
        let quote = ctx.quote("WMATIC", "0x0000", "USDC", "0x0001", 1_000_000u128);
        assert!(quote.reserve_base_raw.is_some());
        assert!(quote.reserve_quote_raw.is_some());
        assert!(quote.sqrt_price_x96.is_none());
    }
}
