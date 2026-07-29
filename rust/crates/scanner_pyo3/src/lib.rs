//! # scanner_pyo3 — Python bindings for the Apex-Omega Rust scanner
//!
//! Exposes the Rust scanner components to Python via PyO3.
//!
//! ## Python API
//!
//! ```python
//! import scanner_pyo3 as sc
//!
//! # Validate a single quote dict
//! result = sc.validate_quote_dict({
//!     "chain_id": 42161,
//!     "protocol": "camelot_v2",
//!     "pool_address": "0x...",
//!     ...
//!     "executable_price": 0.85,
//!     "pool_tvl_usd": 100000.0,
//! })
//!
//! # Run ranking on a list of validated rows (JSON)
//! candidates_json = sc.rank_pairs_json(rows_json, timestamp_ms)
//!
//! # Full pipeline: validate + rank a batch of raw quote dicts
//! scan_result_json = sc.scan_batch_json(quotes_json, timestamp_ms)
//! ```

use pyo3::prelude::*;
use pyo3::exceptions::PyValueError;

use adapters::{PoolQuote, Protocol, SwapDirection};
use ranking::{rank_all, PairRows};
use scanner_core::{CandidateRow, ScanResult, ScanSummary};
use validator::validate_batch;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Parse a `Protocol` from a snake_case string.
#[allow(dead_code)]
fn parse_protocol(s: &str) -> PyResult<Protocol> {
    match s {
        "uniswap_v2"       => Ok(Protocol::UniswapV2),
        "sushi_swap_v2"    => Ok(Protocol::SushiSwapV2),
        "camelot_v2"       => Ok(Protocol::CamelotV2),
        "uniswap_v3"       => Ok(Protocol::UniswapV3),
        "camelot_algebra"  => Ok(Protocol::CamelotAlgebra),
        "generic_v2"       => Ok(Protocol::GenericV2),
        other => Err(PyValueError::new_err(format!("Unknown protocol: {other}"))),
    }
}

/// Parse a `SwapDirection` from a string.
#[allow(dead_code)]
fn parse_direction(s: &str) -> PyResult<SwapDirection> {
    match s {
        "zero_for_one" | "ZeroForOne" => Ok(SwapDirection::ZeroForOne),
        "one_for_zero" | "OneForZero" => Ok(SwapDirection::OneForZero),
        other => Err(PyValueError::new_err(format!("Unknown direction: {other}"))),
    }
}

/// Convert a JSON string representing a list of raw quote dicts into
/// a `Vec<PoolQuote>`.
fn quotes_from_json(json: &str) -> PyResult<Vec<PoolQuote>> {
    serde_json::from_str(json)
        .map_err(|e| PyValueError::new_err(format!("JSON parse error: {e}")))
}

/// Group `CandidateRow` values by (base_token_address, quote_token_address).
fn group_rows(rows: Vec<CandidateRow>, timestamp_ms: u64) -> Vec<PairRows> {
    use std::collections::HashMap;
    let mut map: HashMap<(String, String), Vec<CandidateRow>> = HashMap::new();
    for row in rows {
        let key = (row.base_token_address.clone(), row.quote_token_address.clone());
        map.entry(key).or_default().push(row);
    }
    map.into_iter()
        .map(|((base_addr, quote_addr), rows)| {
            let first = &rows[0];
            PairRows {
                base_token_symbol: first.base_token_symbol.clone(),
                quote_token_symbol: first.quote_token_symbol.clone(),
                base_token_address: base_addr,
                quote_token_address: quote_addr,
                rows,
                scan_timestamp_ms: timestamp_ms,
            }
        })
        .collect()
}

// ─── Python-exposed functions ─────────────────────────────────────────────────

/// Validate a single raw quote dict.
///
/// Args:
///     quote_json: JSON string of a single quote object.
///
/// Returns:
///     JSON string of a `CandidateRow` on success, or raises `ValueError` with
///     the rejection reason.
#[pyfunction]
fn validate_quote_json(quote_json: &str) -> PyResult<String> {
    let quote: PoolQuote = serde_json::from_str(quote_json)
        .map_err(|e| PyValueError::new_err(format!("JSON parse error: {e}")))?;
    match validator::validate_quote(&quote) {
        validator::ValidationResult::Valid(row) => serde_json::to_string(&row)
            .map_err(|e| PyValueError::new_err(format!("Serialization error: {e}"))),
        validator::ValidationResult::Invalid(err) =>
            Err(PyValueError::new_err(format!("Validation failed: {err}"))),
    }
}

/// Validate a JSON array of raw quote objects.
///
/// Args:
///     quotes_json: JSON string of a list of quote objects.
///
/// Returns:
///     Tuple `(valid_rows_json: str, rejected_count: int)`.
///     `valid_rows_json` is a JSON array of `CandidateRow` objects.
#[pyfunction]
fn validate_batch_json(quotes_json: &str) -> PyResult<(String, usize)> {
    let quotes = quotes_from_json(quotes_json)?;
    let (valid, errors) = validate_batch(&quotes);
    let json = serde_json::to_string(&valid)
        .map_err(|e| PyValueError::new_err(format!("Serialization error: {e}")))?;
    Ok((json, errors.len()))
}

/// Rank a JSON array of pre-validated `CandidateRow` objects.
///
/// Args:
///     rows_json:     JSON string of a list of `CandidateRow` objects.
///     timestamp_ms:  Scan timestamp in milliseconds.
///
/// Returns:
///     JSON string of a list of `ArbitrageCandidate` objects sorted by
///     spread descending.
#[pyfunction]
fn rank_pairs_json(rows_json: &str, timestamp_ms: u64) -> PyResult<String> {
    let rows: Vec<CandidateRow> = serde_json::from_str(rows_json)
        .map_err(|e| PyValueError::new_err(format!("JSON parse error: {e}")))?;
    let pairs = group_rows(rows, timestamp_ms);
    let candidates = rank_all(&pairs);
    serde_json::to_string(&candidates)
        .map_err(|e| PyValueError::new_err(format!("Serialization error: {e}")))
}

/// Run the full validate-then-rank pipeline on a batch of raw quote dicts.
///
/// This is the primary entry point for Python callers.
///
/// Args:
///     quotes_json:   JSON string of a list of raw quote objects.
///     timestamp_ms:  Scan timestamp in milliseconds.
///
/// Returns:
///     JSON string of a `ScanResult` object.
#[pyfunction]
fn scan_batch_json(quotes_json: &str, timestamp_ms: u64) -> PyResult<String> {
    let quotes = quotes_from_json(quotes_json)?;
    let total_quotes = quotes.len();

    let (valid_rows, errors) = validate_batch(&quotes);

    // Count rejection reasons
    let rejected_wrong_chain = errors.iter()
        .filter(|e| matches!(e, validator::ValidationError::WrongChain { .. })).count();
    let rejected_low_tvl = errors.iter()
        .filter(|e| matches!(e, validator::ValidationError::TvlBelowGate { .. })).count();
    let rejected_no_price = errors.iter()
        .filter(|e| matches!(e, validator::ValidationError::NoLiveQuote)).count();

    let pairs = group_rows(valid_rows, timestamp_ms);
    let candidates = rank_all(&pairs);

    // Count pair-level rejections
    let mut rejected_insufficient = 0usize;
    let mut rejected_same_pool = 0usize;
    for pair in &pairs {
        match ranking::rank_pair(pair) {
            ranking::RankingOutcome::Rejected(ranking::RejectionReason::InsufficientDestinations) =>
                rejected_insufficient += 1,
            ranking::RankingOutcome::Rejected(ranking::RejectionReason::SamePool) =>
                rejected_same_pool += 1,
            _ => {}
        }
    }

    let result = ScanResult {
        summary: ScanSummary {
            chain_id: 42161,
            scan_timestamp_ms: timestamp_ms,
            total_quotes,
            rejected_wrong_chain,
            rejected_low_tvl,
            rejected_no_price,
            valid_candidates: candidates.len(),
            rejected_insufficient_destinations: rejected_insufficient,
            rejected_same_pool,
        },
        candidates,
    };

    serde_json::to_string(&result)
        .map_err(|e| PyValueError::new_err(format!("Serialization error: {e}")))
}

/// Compute the two-pool CFMM arbitrage profit for a given input amount.
///
/// Args:
///     x:       Input amount (raw token units, as int).
///     r1, s1:  Reserves of pool 1 (raw units).
///     fee1:    Fee in basis points for pool 1 (e.g. 30 for 0.3 %).
///     r2, s2:  Reserves of pool 2 (raw units).
///     fee2:    Fee in basis points for pool 2.
///
/// Returns:
///     Profit in raw token units (int).
#[pyfunction]
#[pyo3(signature = (x, r1, s1, fee1, r2, s2, fee2))]
fn cfmm_arb_profit(
    x: u128,
    r1: u128, s1: u128, fee1: u32,
    r2: u128, s2: u128, fee2: u32,
) -> u128 {
    rust_math::cfmm_arb_profit(x, r1, s1, fee1, r2, s2, fee2)
}

/// Compute the closed-form optimal two-pool CFMM input x*.
///
/// Returns `0` if no profitable arb exists.
#[pyfunction]
#[pyo3(signature = (r1, s1, fee1, r2, s2, fee2))]
fn cfmm_optimal_input(
    r1: u128, s1: u128, fee1: u32,
    r2: u128, s2: u128, fee2: u32,
) -> u128 {
    rust_math::cfmm_optimal_input(r1, s1, fee1, r2, s2, fee2)
}

/// Compute the exact UniV2 output amount for given reserves and input.
#[pyfunction]
fn cfmm_amount_out(reserve_in: u128, reserve_out: u128, amount_in: u128, fee_bps: u32) -> u128 {
    rust_math::cfmm_amount_out(reserve_in, reserve_out, amount_in, fee_bps)
}

// ─── Module registration ──────────────────────────────────────────────────────

/// Apex-Omega Chain-42161 (Arbitrum One) scanner — Rust/PyO3 core.
#[pymodule]
fn scanner_pyo3(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(validate_quote_json, m)?)?;
    m.add_function(wrap_pyfunction!(validate_batch_json, m)?)?;
    m.add_function(wrap_pyfunction!(rank_pairs_json, m)?)?;
    m.add_function(wrap_pyfunction!(scan_batch_json, m)?)?;
    m.add_function(wrap_pyfunction!(cfmm_arb_profit, m)?)?;
    m.add_function(wrap_pyfunction!(cfmm_optimal_input, m)?)?;
    m.add_function(wrap_pyfunction!(cfmm_amount_out, m)?)?;
    // Expose constants
    m.add("ARBITRUM_CHAIN_ID", 42161u64)?;
    m.add("MIN_POOL_TVL_USD", 50_000.0f64)?;
    Ok(())
}
