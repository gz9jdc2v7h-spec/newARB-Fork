//! # Ranking Engine
//!
//! Executable-price-driven leg selection — Apex-Omega canon.
//!
//! ## Selection law (immutable)
//! ```text
//! best_buy  = min(valid_rows, key=lambda r: r.buy_price_executable_usd_per_base)
//! best_sell = max(valid_rows, key=lambda r: r.sell_price_executable_usd_per_base)
//! ```
//!
//! ### What may NOT override the leg selection
//! - Metadata
//! - Protocol tag
//! - Venue
//! - Router type
//!
//! ### What DOES select the leg
//! Executable price — and only executable price.

use scanner_core::{ArbitrageCandidate, CandidateRow};
use serde::{Deserialize, Serialize};

// ─── Ranking input ────────────────────────────────────────────────────────────

/// A collection of [`CandidateRow`] values for one base/quote pair.
///
/// All rows must share the same `base_token_address` and `quote_token_address`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairRows {
    pub base_token_symbol: String,
    pub quote_token_symbol: String,
    pub base_token_address: String,
    pub quote_token_address: String,
    pub rows: Vec<CandidateRow>,
    pub scan_timestamp_ms: u64,
}

// ─── Ranking result ───────────────────────────────────────────────────────────

/// Reason a pair was not ranked into a candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum RejectionReason {
    /// Fewer than 2 rows with valid executable prices.
    InsufficientDestinations,
    /// Best buy and best sell resolve to the same pool.
    SamePool,
    /// Best sell price ≤ best buy price (no positive spread).
    NegativeSpread,
}

/// Outcome of attempting to rank a [`PairRows`] collection.
#[derive(Debug, Clone)]
pub enum RankingOutcome {
    /// Valid candidate produced.
    Candidate(ArbitrageCandidate),
    /// Pair was rejected for the stated reason.
    Rejected(RejectionReason),
}

// ─── Core ranking function ────────────────────────────────────────────────────

/// Select the best buy and best sell from a set of rows for one pair.
///
/// ### Selection law
/// ```text
/// best_buy  = row with min buy_price_executable_usd_per_base
/// best_sell = row with max sell_price_executable_usd_per_base
/// ```
///
/// Returns `None` if fewer than 2 rows have a positive executable price.
fn select_legs(rows: &[CandidateRow]) -> Option<(&CandidateRow, &CandidateRow)> {
    let valid: Vec<&CandidateRow> = rows
        .iter()
        .filter(|r| r.buy_price_executable_usd_per_base > 0.0)
        .collect();

    if valid.len() < 2 {
        return None;
    }

    let best_buy = valid
        .iter()
        .copied()
        .min_by(|a, b| {
            a.buy_price_executable_usd_per_base
                .partial_cmp(&b.buy_price_executable_usd_per_base)
                .unwrap_or(std::cmp::Ordering::Equal)
        })?;

    let best_sell = valid
        .iter()
        .copied()
        .max_by(|a, b| {
            a.sell_price_executable_usd_per_base
                .partial_cmp(&b.sell_price_executable_usd_per_base)
                .unwrap_or(std::cmp::Ordering::Equal)
        })?;

    Some((best_buy, best_sell))
}

/// Rank a [`PairRows`] collection into an [`ArbitrageCandidate`] or a rejection.
///
/// Enforces all Apex-Omega gate laws that are knowable at ranking time:
/// - ≥ 2 valid executable destinations
/// - distinct buy/sell pool addresses
/// - positive spread (sell price > buy price)
pub fn rank_pair(pair: &PairRows) -> RankingOutcome {
    let valid_count = pair
        .rows
        .iter()
        .filter(|r| r.buy_price_executable_usd_per_base > 0.0)
        .count();

    if valid_count < 2 {
        return RankingOutcome::Rejected(RejectionReason::InsufficientDestinations);
    }

    let (best_buy, best_sell) = match select_legs(&pair.rows) {
        Some(legs) => legs,
        None => return RankingOutcome::Rejected(RejectionReason::InsufficientDestinations),
    };

    // Same-pool round-trip rejection
    if best_buy.pool_address.to_lowercase() == best_sell.pool_address.to_lowercase() {
        return RankingOutcome::Rejected(RejectionReason::SamePool);
    }

    let buy_price = best_buy.buy_price_executable_usd_per_base;
    let sell_price = best_sell.sell_price_executable_usd_per_base;

    if sell_price <= buy_price {
        return RankingOutcome::Rejected(RejectionReason::NegativeSpread);
    }

    let spread = (sell_price - buy_price) / buy_price;
    let gross_profit_per_unit = sell_price - buy_price;

    RankingOutcome::Candidate(ArbitrageCandidate {
        chain_id: best_buy.chain_id,
        base_token_symbol: pair.base_token_symbol.clone(),
        quote_token_symbol: pair.quote_token_symbol.clone(),
        base_token_address: pair.base_token_address.clone(),
        quote_token_address: pair.quote_token_address.clone(),
        best_buy: best_buy.clone(),
        best_sell: best_sell.clone(),
        spread,
        gross_profit_per_unit,
        num_destinations: valid_count,
        scan_timestamp_ms: pair.scan_timestamp_ms,
    })
}

/// Rank all pairs and return only valid candidates, sorted by spread descending.
pub fn rank_all(pairs: &[PairRows]) -> Vec<ArbitrageCandidate> {
    let mut candidates: Vec<ArbitrageCandidate> = pairs
        .iter()
        .filter_map(|p| match rank_pair(p) {
            RankingOutcome::Candidate(c) => Some(c),
            RankingOutcome::Rejected(_) => None,
        })
        .collect();

    candidates.sort_by(|a, b| {
        b.spread
            .partial_cmp(&a.spread)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    candidates
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use adapters::Protocol;

    fn make_row(pool: &str, price: f64) -> CandidateRow {
        CandidateRow {
            chain_id: 137,
            protocol: Protocol::QuickSwapV2,
            pool_address: pool.to_string(),
            base_token_symbol: "WMATIC".to_string(),
            quote_token_symbol: "USDC".to_string(),
            base_token_address: "0xbase".to_string(),
            quote_token_address: "0xquote".to_string(),
            base_decimals: 18,
            quote_decimals: 6,
            buy_price_executable_usd_per_base: price,
            sell_price_executable_usd_per_base: price,
            amount_in_raw: 1_000_000_000_000_000_000,
            amount_out_raw: (price * 1_000_000.0) as u128,
            fee_ppm: 3000,
            pool_tvl_usd: 100_000.0,
            timestamp_ms: 0,
            reserve_base_raw: None,
            reserve_quote_raw: None,
            sqrt_price_x96: None,
        }
    }

    fn make_pair(rows: Vec<CandidateRow>) -> PairRows {
        PairRows {
            base_token_symbol: "WMATIC".to_string(),
            quote_token_symbol: "USDC".to_string(),
            base_token_address: "0xbase".to_string(),
            quote_token_address: "0xquote".to_string(),
            rows,
            scan_timestamp_ms: 0,
        }
    }

    #[test]
    fn test_ranks_best_buy_and_sell() {
        let pair = make_pair(vec![
            make_row("0xpool_a", 0.80),
            make_row("0xpool_b", 0.85),
            make_row("0xpool_c", 0.78),
        ]);
        match rank_pair(&pair) {
            RankingOutcome::Candidate(c) => {
                // best buy = min price = 0.78
                assert!((c.best_buy.buy_price_executable_usd_per_base - 0.78).abs() < 1e-9);
                // best sell = max price = 0.85
                assert!((c.best_sell.sell_price_executable_usd_per_base - 0.85).abs() < 1e-9);
                assert!(c.spread > 0.0);
            }
            RankingOutcome::Rejected(r) => panic!("unexpected rejection: {r:?}"),
        }
    }

    #[test]
    fn test_rejects_same_pool() {
        let pair = make_pair(vec![
            make_row("0xpool_a", 0.80),
            make_row("0xpool_a", 0.85), // same pool, different price (e.g. stale data)
        ]);
        // Both best buy and best sell resolve to "0xpool_a"
        match rank_pair(&pair) {
            RankingOutcome::Rejected(RejectionReason::SamePool) => {}
            other => panic!("expected SamePool rejection, got {other:?}"),
        }
    }

    #[test]
    fn test_rejects_insufficient_destinations() {
        let pair = make_pair(vec![make_row("0xpool_a", 0.80)]);
        match rank_pair(&pair) {
            RankingOutcome::Rejected(RejectionReason::InsufficientDestinations) => {}
            other => panic!("expected InsufficientDestinations, got {other:?}"),
        }
    }

    #[test]
    fn test_rejects_zero_price_rows() {
        let pair = make_pair(vec![
            make_row("0xpool_a", 0.80),
            make_row("0xpool_b", 0.0), // invalid — no price
        ]);
        match rank_pair(&pair) {
            RankingOutcome::Rejected(RejectionReason::InsufficientDestinations) => {}
            other => panic!("expected InsufficientDestinations, got {other:?}"),
        }
    }

    #[test]
    fn test_rejects_negative_spread() {
        // When best sell happens to be the same pool as best buy this resolves
        // to SamePool, but we can force NegativeSpread with two pools where
        // the higher price is the buy side.
        let pair = make_pair(vec![
            make_row("0xpool_a", 0.80),
            make_row("0xpool_b", 0.80), // equal prices → spread = 0
        ]);
        // Equal prices: best_buy.pool ≠ best_sell.pool but spread <= 0
        match rank_pair(&pair) {
            RankingOutcome::Rejected(RejectionReason::NegativeSpread) => {}
            other => panic!("expected NegativeSpread, got {other:?}"),
        }
    }

    #[test]
    fn test_rank_all_sorted_by_spread() {
        let pair1 = make_pair(vec![make_row("0xa", 0.80), make_row("0xb", 0.90)]);
        let pair2 = make_pair(vec![make_row("0xc", 0.70), make_row("0xd", 0.95)]);
        let results = rank_all(&[pair1, pair2]);
        assert_eq!(results.len(), 2);
        // pair2 has a larger spread
        assert!(results[0].spread >= results[1].spread);
    }
}
