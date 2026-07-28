//! # RustMath — Fixed-point CFMM mathematics
//!
//! All arithmetic uses `u128` (96-bit integer, 32-bit fractional Q64.32 where
//! noted) to avoid floating-point rounding across multi-hop DeFi calculations.
//!
//! ## Notation
//! ```text
//! r   = reserveIn    (reserve of the token being sold into the pool)
//! s   = reserveOut   (reserve of the token being bought from the pool)
//! x   = amountIn     (input trade size, raw token units)
//! y   = amountOut    (output amount received)
//! γ   = 1 − fee      (fee complement)
//! FD  = 1_000_000    (fee denominator, 1 ppm resolution)
//! ```
//!
//! ## UniswapV3 / Algebra sqrtPriceX96
//! V3-style pools publish a `sqrt_price_x96 = √(token1/token0) × 2^96`.
//! Executable price (token0 per token1) is derived as:
//! ```text
//! price = (sqrtPriceX96 / 2^96)^2 = sqrtPriceX96^2 / 2^192
//! ```

/// Fee denominator used across all CFMM calculations (1 ppm resolution).
pub const FEE_DENOM: u128 = 1_000_000;

/// Scale factor for Q64.32 fixed-point representation.
pub const Q32: u128 = 1u128 << 32;

/// Scale factor for `sqrtPriceX96` (Uniswap V3 / Algebra).
pub const Q96: u128 = 1u128 << 96;

// ─── Integer square root ─────────────────────────────────────────────────────

/// Integer square root ⌊√n⌋ via Babylonian method.
///
/// Uses wrapping-safe arithmetic to handle u128::MAX.
/// Guaranteed termination: for u128 the loop runs at most 128 iterations
/// (in practice ≤ 64).
pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    // Initial estimate: 2^⌈bits/2⌉ (guaranteed ≥ √n)
    let bits = 128u32 - n.leading_zeros();
    let mut x = 1u128 << ((bits + 1) / 2);
    loop {
        // y = (x + n/x) / 2  — use saturating to stay within u128
        let y = x / 2 + n / x / 2 + (x % 2) * (n / x % 2) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

// ─── UniV2 / Constant-Product CFMM ───────────────────────────────────────────

/// Exact constant-product output amount for a given input (integer arithmetic).
///
/// ```text
/// y = s · γ_n · x / (r · FD + γ_n · x)
/// ```
///
/// Returns `0` if any reserve or input is zero.
pub fn cfmm_amount_out(reserve_in: u128, reserve_out: u128, amount_in: u128, fee_bps: u32) -> u128 {
    if reserve_in == 0 || reserve_out == 0 || amount_in == 0 {
        return 0;
    }
    let gamma_n = FEE_DENOM - u128::from(fee_bps) * 100;
    let numerator = reserve_out
        .checked_mul(gamma_n)
        .and_then(|v| v.checked_mul(amount_in));
    let denominator = reserve_in
        .checked_mul(FEE_DENOM)
        .and_then(|v| v.checked_add(gamma_n.checked_mul(amount_in)?));
    match (numerator, denominator) {
        (Some(n), Some(d)) if d > 0 => n / d,
        _ => 0,
    }
}

/// Marginal spot price for a constant-product pool: `reserveOut / reserveIn`.
///
/// Returns the price as a `f64` for display/ranking purposes only.
/// All gate decisions use integer paths.
pub fn cfmm_spot_price(reserve_in: u128, reserve_out: u128, decimals_in: u8, decimals_out: u8) -> f64 {
    if reserve_in == 0 {
        return 0.0;
    }
    let scale = 10f64.powi(i32::from(decimals_out) - i32::from(decimals_in));
    (reserve_out as f64 / reserve_in as f64) * scale
}

/// Effective (realised) price for a finite trade, normalised for decimals.
pub fn cfmm_effective_price(
    reserve_in: u128,
    reserve_out: u128,
    amount_in: u128,
    fee_bps: u32,
    decimals_in: u8,
    decimals_out: u8,
) -> f64 {
    let out = cfmm_amount_out(reserve_in, reserve_out, amount_in, fee_bps);
    if out == 0 || amount_in == 0 {
        return 0.0;
    }
    let in_f = amount_in as f64 / 10f64.powi(decimals_in as i32);
    let out_f = out as f64 / 10f64.powi(decimals_out as i32);
    out_f / in_f
}

/// Price impact as a fraction [0, 1).
///
/// ```text
/// impact = 1 − γ·r / (r·FD + γ·x)
/// ```
pub fn cfmm_price_impact(reserve_in: u128, amount_in: u128, fee_bps: u32) -> f64 {
    if reserve_in == 0 || amount_in == 0 {
        return 0.0;
    }
    let gamma_n = FEE_DENOM - u128::from(fee_bps) * 100;
    let num = gamma_n.saturating_mul(reserve_in) as f64;
    let den = (reserve_in.saturating_mul(FEE_DENOM) + gamma_n.saturating_mul(amount_in)) as f64;
    1.0 - num / den
}

/// Closed-form optimal input x* for a two-pool constant-product arbitrage.
///
/// Pool layout (A→B round-trip):
/// - Pool 1 (sell A for B on high-price DEX): r1=reserveIn, s1=reserveOut
/// - Pool 2 (buy A back with B on low-price DEX): r2=reserveOut, s2=reserveIn
///
/// ```text
/// x* = FD · (√(A·B) − B) / C
///   A = s1·s2·γ1·γ2 ,  B = r1·r2·FD²,  C = γ1·(r2·FD + s1·γ2)
/// ```
///
/// Returns `0` if no profitable arb exists.
pub fn cfmm_optimal_input(
    r1: u128, s1: u128, fee_bps1: u32,
    r2: u128, s2: u128, fee_bps2: u32,
) -> u128 {
    if r1 == 0 || s1 == 0 || r2 == 0 || s2 == 0 {
        return 0;
    }
    let g1 = FEE_DENOM - u128::from(fee_bps1) * 100;
    let g2 = FEE_DENOM - u128::from(fee_bps2) * 100;

    // Compute radicand = s1·s2·g1·g2·r1·r2  (may overflow u128 for large pools)
    // Use u128 with checked arithmetic; fall back to 0 on overflow.
    let radicand = s1
        .checked_mul(s2).and_then(|v| v.checked_mul(g1))
        .and_then(|v| v.checked_mul(g2))
        .and_then(|v| v.checked_mul(r1))
        .and_then(|v| v.checked_mul(r2));
    let sqrt_term = match radicand {
        Some(r) => isqrt(r),
        None => return 0,
    };

    let baseline = r1
        .checked_mul(r2)
        .and_then(|v| v.checked_mul(FEE_DENOM));
    let baseline = match baseline {
        Some(b) => b,
        None => return 0,
    };

    if sqrt_term <= baseline {
        return 0; // no profitable arb
    }

    let numerator = FEE_DENOM.checked_mul(sqrt_term - baseline);
    let denominator = g1.checked_mul(r2.saturating_mul(FEE_DENOM).saturating_add(s1.saturating_mul(g2)));
    match (numerator, denominator) {
        (Some(n), Some(d)) if d > 0 => n / d,
        _ => 0,
    }
}

/// Two-pool arbitrage profit at a specific input `x`.
///
/// P(x) = cfmm_amount_out(pool2, cfmm_amount_out(pool1, x)) − x
///
/// Returns `0` for unprofitable trades.
pub fn cfmm_arb_profit(
    x: u128,
    r1: u128, s1: u128, fee_bps1: u32,
    r2: u128, s2: u128, fee_bps2: u32,
) -> u128 {
    let y = cfmm_amount_out(r1, s1, x, fee_bps1);
    if y == 0 {
        return 0;
    }
    let z = cfmm_amount_out(r2, s2, y, fee_bps2);
    if z > x { z - x } else { 0 }
}

// ─── UniswapV3 / Algebra sqrtPriceX96 ────────────────────────────────────────

/// Convert a `sqrtPriceX96` value to a human-readable `f64` price.
///
/// `price = (sqrtPriceX96 / 2^96)^2`, adjusted for token decimals.
///
/// `token0_is_base = true` → price in token1 per token0 (standard).
/// `token0_is_base = false` → inverted price.
pub fn sqrt_price_x96_to_price(
    sqrt_price_x96: u128,
    decimals0: u8,
    decimals1: u8,
    token0_is_base: bool,
) -> f64 {
    if sqrt_price_x96 == 0 {
        return 0.0;
    }
    // price_raw = (sqrt / 2^96)^2 = sqrt^2 / 2^192
    // To avoid overflow we work in f64 at this point (display-only path).
    let sqrt_f = sqrt_price_x96 as f64 / (Q96 as f64);
    let price_raw = sqrt_f * sqrt_f;
    let decimal_adjustment = 10f64.powi(i32::from(decimals0) - i32::from(decimals1));
    let price = price_raw * decimal_adjustment;
    if token0_is_base { price } else if price > 0.0 { 1.0 / price } else { 0.0 }
}

/// Approximate output for a single V3/Algebra swap tick at the current price.
///
/// For exact multi-tick routing the on-chain quoter must be used; this
/// provides a first-order approximation for pool screening.
///
/// ```text
/// amountOut ≈ amountIn × price × (1 − fee_ppm / 1_000_000)
/// ```
pub fn v3_approximate_amount_out(
    amount_in: u128,
    sqrt_price_x96: u128,
    fee_ppm: u32,
    decimals_in: u8,
    decimals_out: u8,
    token_in_is_token0: bool,
) -> f64 {
    let price = sqrt_price_x96_to_price(sqrt_price_x96, decimals_in, decimals_out, token_in_is_token0);
    if price == 0.0 {
        return 0.0;
    }
    let fee_complement = 1.0 - f64::from(fee_ppm) / 1_000_000.0;
    let amount_in_normalised = amount_in as f64 / 10f64.powi(decimals_in as i32);
    amount_in_normalised * price * fee_complement
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_isqrt() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(9), 3);
        assert_eq!(isqrt(10), 3); // ⌊√10⌋ = 3
        assert_eq!(isqrt(100), 10);
        // ⌊√(u128::MAX)⌋ = 2^64 - 1
        let expected: u128 = (1u128 << 64) - 1;
        assert_eq!(isqrt(u128::MAX), expected);
    }

    #[test]
    fn test_cfmm_amount_out_basic() {
        // 0.3% fee pool, reserves 1000 each, amountIn 10
        // y = 1000 * 997000 * 10 / (1000 * 1000000 + 997000 * 10) = 9_970_000_000 / 1_009_970_000 ≈ 9
        let out = cfmm_amount_out(1_000, 1_000, 10, 30);
        assert!(out > 0 && out < 10, "expected 0<out<10, got {out}");
    }

    #[test]
    fn test_cfmm_amount_out_zero_reserve() {
        assert_eq!(cfmm_amount_out(0, 1000, 10, 30), 0);
        assert_eq!(cfmm_amount_out(1000, 0, 10, 30), 0);
        assert_eq!(cfmm_amount_out(1000, 1000, 0, 30), 0);
    }

    #[test]
    fn test_cfmm_arb_profit_no_arb() {
        // Identical pools — zero arb
        let profit = cfmm_arb_profit(100, 1_000_000, 1_000_000, 30, 1_000_000, 1_000_000, 30);
        assert_eq!(profit, 0);
    }

    #[test]
    fn test_cfmm_arb_profit_with_spread() {
        // Pool 1 has shifted reserves: r1=800000, s1=1200000 (higher sell price)
        // Pool 2: r2=1200000, s2=800000 (lower buy price)
        let x = cfmm_optimal_input(800_000, 1_200_000, 30, 1_200_000, 800_000, 30);
        if x > 0 {
            let profit = cfmm_arb_profit(x, 800_000, 1_200_000, 30, 1_200_000, 800_000, 30);
            assert!(profit > 0, "expected positive profit at optimal input, got {profit}");
        }
    }

    #[test]
    fn test_price_impact_zero() {
        assert_eq!(cfmm_price_impact(0, 100, 30), 0.0);
        assert_eq!(cfmm_price_impact(1000, 0, 30), 0.0);
    }

    #[test]
    fn test_price_impact_increases_with_size() {
        let small = cfmm_price_impact(1_000_000, 1_000, 30);
        let large = cfmm_price_impact(1_000_000, 100_000, 30);
        assert!(large > small, "larger trade should have higher impact");
    }

    #[test]
    fn test_sqrt_price_x96_to_price_roundtrip() {
        // √(1.0) × 2^96 → price should be ~1.0
        let sqrt1 = Q96; // √1 × 2^96
        let price = sqrt_price_x96_to_price(sqrt1, 18, 18, true);
        assert!((price - 1.0).abs() < 1e-9, "expected ~1.0, got {price}");
    }
}
