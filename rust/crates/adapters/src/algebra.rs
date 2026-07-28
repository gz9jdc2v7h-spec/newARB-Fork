//! QuickSwap Algebra adapter — **separate model** per Apex-Omega canon.
//!
//! Algebra is an AMM descended from Uniswap V3 but uses its **own**
//! factory, pool, and data-provider ABIs.  It must not be routed through
//! the Uniswap V3 ABI path.
//!
//! Key differences from UniV3:
//! - Single "global fee" stored in the pool (not in the factory fee tier).
//! - `globalState()` replaces `slot0()` and returns `(sqrtPriceX96, tick,
//!   feeZto, feeOtz, timepointIndex, communityFeeToken0, communityFeeToken1,
//!   unlocked)`.
//! - Pool address derivation uses the Algebra factory, not the UniV3 factory.

use rust_math::{sqrt_price_x96_to_price, v3_approximate_amount_out};
use serde::{Deserialize, Serialize};

use crate::{PoolQuote, Protocol, SwapDirection};

/// Algebra pool globalState (returned by `IAlgebraPool.globalState()`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlgebraGlobalState {
    pub sqrt_price_x96: u128,
    pub tick: i32,
    /// Fee for token0→token1 swaps (ppm).
    pub fee_zto: u16,
    /// Fee for token1→token0 swaps (ppm).
    pub fee_otz: u16,
    pub timepoint_index: u16,
    pub community_fee_token0: u8,
    pub community_fee_token1: u8,
    pub unlocked: bool,
}

/// Pool context for a QuickSwap Algebra pool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlgebraPoolContext {
    pub chain_id: u64,
    pub pool_address: String,
    pub token0_address: String,
    pub token1_address: String,
    pub token0_symbol: String,
    pub token1_symbol: String,
    pub token0_decimals: u8,
    pub token1_decimals: u8,
    pub global_state: AlgebraGlobalState,
    /// Total value locked in USD.
    pub tvl_usd: f64,
    pub timestamp_ms: u64,
}

impl AlgebraPoolContext {
    /// Returns the effective fee in ppm for the requested direction.
    pub fn fee_ppm(&self, zero_for_one: bool) -> u32 {
        if zero_for_one {
            u32::from(self.global_state.fee_zto)
        } else {
            u32::from(self.global_state.fee_otz)
        }
    }

    /// Produce an approximate [`PoolQuote`] using `sqrtPriceX96` from
    /// Algebra's `globalState`.
    ///
    /// **This is a first-order approximation.**  For the gate decision
    /// the Algebra DataStorageOperator quoter must be called for an exact
    /// quote — the V3 quoter cannot be used here.
    pub fn approximate_quote(
        &self,
        base_symbol: &str,
        base_address: &str,
        quote_symbol: &str,
        quote_address: &str,
        amount_in_raw: u128,
    ) -> PoolQuote {
        let token_in_is_token0 = base_address.to_lowercase() == self.token0_address.to_lowercase();
        let (decimals_in, decimals_out) = if token_in_is_token0 {
            (self.token0_decimals, self.token1_decimals)
        } else {
            (self.token1_decimals, self.token0_decimals)
        };
        let fee_ppm = self.fee_ppm(token_in_is_token0);

        let amount_out_f = v3_approximate_amount_out(
            amount_in_raw,
            self.global_state.sqrt_price_x96,
            fee_ppm,
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
            protocol: Protocol::QuickSwapAlgebra,
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
            fee_ppm,
            pool_tvl_usd: self.tvl_usd,
            timestamp_ms: self.timestamp_ms,
            reserve_base_raw: None,
            reserve_quote_raw: None,
            sqrt_price_x96: Some(self.global_state.sqrt_price_x96),
            direction,
        }
    }

    /// Spot price for token0 in terms of token1 (display only).
    pub fn spot_price_token0_in_token1(&self) -> f64 {
        sqrt_price_x96_to_price(
            self.global_state.sqrt_price_x96,
            self.token0_decimals,
            self.token1_decimals,
            true,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_context() -> AlgebraPoolContext {
        AlgebraPoolContext {
            chain_id: 137,
            pool_address: "0xEFGH".to_string(),
            token0_address: "0x0000".to_string(),
            token1_address: "0x0001".to_string(),
            token0_symbol: "WMATIC".to_string(),
            token1_symbol: "USDC".to_string(),
            token0_decimals: 18,
            token1_decimals: 6,
            global_state: AlgebraGlobalState {
                sqrt_price_x96: 56_022_770_974_786_143_748_341_760,
                tick: -3_000,
                fee_zto: 2500,
                fee_otz: 2500,
                timepoint_index: 0,
                community_fee_token0: 0,
                community_fee_token1: 0,
                unlocked: true,
            },
            tvl_usd: 250_000.0,
            timestamp_ms: 0,
        }
    }

    #[test]
    fn test_algebra_quote_protocol_tag() {
        let ctx = make_context();
        let quote = ctx.approximate_quote(
            "WMATIC", "0x0000",
            "USDC",   "0x0001",
            1_000_000_000_000_000_000u128,
        );
        // Must be tagged as Algebra, not UniswapV3
        assert_eq!(quote.protocol, Protocol::QuickSwapAlgebra);
        assert_ne!(quote.protocol, Protocol::UniswapV3);
    }

    #[test]
    fn test_algebra_fee_direction() {
        let ctx = make_context();
        assert_eq!(ctx.fee_ppm(true), 2500);
        assert_eq!(ctx.fee_ppm(false), 2500);
    }

    #[test]
    fn test_algebra_chain_id() {
        let ctx = make_context();
        let quote = ctx.approximate_quote("WMATIC", "0x0000", "USDC", "0x0001", 1_000u128);
        assert_eq!(quote.chain_id, 137);
    }
}
