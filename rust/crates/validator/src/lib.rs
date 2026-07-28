//! # Candidate Validator
//!
//! Enforces all Apex-Omega gate laws before a row enters the ranking engine.
//!
//! ## Gate laws (all must pass)
//! 1. `chain_id == 137`
//! 2. `pool_tvl_usd >= 50_000`
//! 3. Live executable quote exists (`executable_price > 0`)
//! 4. ≥ 2 comparable executable destinations (enforced by the ranker post-validation)
//! 5. `buy destination != sell destination` (enforced by the ranker)
//! 6. `buy pool/address/id != sell pool/address/id` (enforced by the ranker)
//! 7. `buy executable price < sell executable price` (enforced by the ranker)
//!
//! Laws 4–7 require a pair-level view and are enforced in `ranking::rank_pair`.
//! This module validates individual rows (laws 1–3).

use adapters::PoolQuote;
use scanner_core::{CandidateRow, MIN_POOL_TVL_USD, POLYGON_CHAIN_ID};
use serde::{Deserialize, Serialize};

/// Reason a row was rejected by the validator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ValidationError {
    /// `chain_id != 137`
    WrongChain { found: u64 },
    /// `pool_tvl_usd < MIN_POOL_TVL_USD`  (includes missing/unknown TVL)
    TvlBelowGate { tvl_usd: u64 },
    /// Executable price is zero or negative (no live quote).
    NoLiveQuote,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValidationError::WrongChain { found } =>
                write!(f, "wrong chain: expected {POLYGON_CHAIN_ID}, got {found}"),
            ValidationError::TvlBelowGate { tvl_usd } =>
                write!(f, "TVL ${tvl_usd} below gate ${}", MIN_POOL_TVL_USD as u64),
            ValidationError::NoLiveQuote =>
                write!(f, "no live executable quote (price = 0)"),
        }
    }
}

/// Result of validating a single [`PoolQuote`].
#[derive(Debug)]
pub enum ValidationResult {
    Valid(CandidateRow),
    Invalid(ValidationError),
}

/// Validate a single [`PoolQuote`] against all row-level gate laws.
///
/// Returns a [`CandidateRow`] on success or a [`ValidationError`] on failure.
///
/// Laws 4–7 (pair-level) are enforced separately by the ranking engine.
pub fn validate_quote(quote: &PoolQuote) -> ValidationResult {
    // Gate 1: chain_id must be 137
    if quote.chain_id != POLYGON_CHAIN_ID {
        return ValidationResult::Invalid(ValidationError::WrongChain { found: quote.chain_id });
    }

    // Gate 2: TVL >= $50,000
    if quote.pool_tvl_usd < MIN_POOL_TVL_USD || !quote.pool_tvl_usd.is_finite() {
        return ValidationResult::Invalid(ValidationError::TvlBelowGate {
            tvl_usd: quote.pool_tvl_usd.max(0.0) as u64,
        });
    }

    // Gate 3: live executable price
    if quote.executable_price <= 0.0 || !quote.executable_price.is_finite() {
        return ValidationResult::Invalid(ValidationError::NoLiveQuote);
    }

    ValidationResult::Valid(CandidateRow::from_quote(quote))
}

/// Validate a batch of quotes.
///
/// Returns `(valid_rows, errors)`.
pub fn validate_batch(quotes: &[PoolQuote]) -> (Vec<CandidateRow>, Vec<ValidationError>) {
    let mut valid = Vec::new();
    let mut errors = Vec::new();
    for q in quotes {
        match validate_quote(q) {
            ValidationResult::Valid(row) => valid.push(row),
            ValidationResult::Invalid(err) => errors.push(err),
        }
    }
    (valid, errors)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use adapters::{Protocol, SwapDirection};

    fn make_quote(chain_id: u64, tvl: f64, price: f64) -> PoolQuote {
        PoolQuote {
            chain_id,
            protocol: Protocol::QuickSwapV2,
            pool_address: "0xpool".to_string(),
            base_token: "WMATIC".to_string(),
            quote_token: "USDC".to_string(),
            base_token_address: "0xbase".to_string(),
            quote_token_address: "0xquote".to_string(),
            base_decimals: 18,
            quote_decimals: 6,
            amount_in_raw: 1_000_000_000_000_000_000,
            amount_out_raw: (price * 1_000_000.0) as u128,
            executable_price: price,
            fee_ppm: 3000,
            pool_tvl_usd: tvl,
            timestamp_ms: 0,
            reserve_base_raw: None,
            reserve_quote_raw: None,
            sqrt_price_x96: None,
            direction: SwapDirection::ZeroForOne,
        }
    }

    #[test]
    fn test_valid_quote_passes() {
        let q = make_quote(137, 100_000.0, 0.85);
        assert!(matches!(validate_quote(&q), ValidationResult::Valid(_)));
    }

    #[test]
    fn test_wrong_chain_rejected() {
        let q = make_quote(1, 100_000.0, 0.85); // Ethereum mainnet
        match validate_quote(&q) {
            ValidationResult::Invalid(ValidationError::WrongChain { found: 1 }) => {}
            other => panic!("expected WrongChain, got {other:?}"),
        }
    }

    #[test]
    fn test_low_tvl_rejected() {
        let q = make_quote(137, 49_999.99, 0.85);
        match validate_quote(&q) {
            ValidationResult::Invalid(ValidationError::TvlBelowGate { .. }) => {}
            other => panic!("expected TvlBelowGate, got {other:?}"),
        }
    }

    #[test]
    fn test_zero_tvl_rejected() {
        let q = make_quote(137, 0.0, 0.85);
        match validate_quote(&q) {
            ValidationResult::Invalid(ValidationError::TvlBelowGate { .. }) => {}
            other => panic!("expected TvlBelowGate, got {other:?}"),
        }
    }

    #[test]
    fn test_exactly_50k_tvl_passes() {
        let q = make_quote(137, 50_000.0, 0.85);
        assert!(matches!(validate_quote(&q), ValidationResult::Valid(_)));
    }

    #[test]
    fn test_zero_price_rejected() {
        let q = make_quote(137, 100_000.0, 0.0);
        match validate_quote(&q) {
            ValidationResult::Invalid(ValidationError::NoLiveQuote) => {}
            other => panic!("expected NoLiveQuote, got {other:?}"),
        }
    }

    #[test]
    fn test_nan_price_rejected() {
        let q = make_quote(137, 100_000.0, f64::NAN);
        match validate_quote(&q) {
            ValidationResult::Invalid(ValidationError::NoLiveQuote) => {}
            other => panic!("expected NoLiveQuote, got {other:?}"),
        }
    }

    #[test]
    fn test_nan_tvl_rejected() {
        let q = make_quote(137, f64::NAN, 0.85);
        match validate_quote(&q) {
            ValidationResult::Invalid(ValidationError::TvlBelowGate { .. }) => {}
            other => panic!("expected TvlBelowGate, got {other:?}"),
        }
    }

    #[test]
    fn test_validate_batch_counts() {
        let quotes = vec![
            make_quote(137, 100_000.0, 0.85),  // valid
            make_quote(1,   100_000.0, 0.85),   // wrong chain
            make_quote(137, 10_000.0, 0.85),    // low TVL
            make_quote(137, 100_000.0, 0.0),    // no price
        ];
        let (valid, errors) = validate_batch(&quotes);
        assert_eq!(valid.len(), 1);
        assert_eq!(errors.len(), 3);
    }
}
