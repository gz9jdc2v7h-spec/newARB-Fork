//! Output schema for the Apex-Omega Chain-137 scanner.
//!
//! ### DNA doctrine
//! Every field present in the original pool quote is preserved verbatim in
//! [`CandidateRow`].  Metadata is "origin DNA" — it provides proof, validation
//! context, and downstream traceability, but it **never overrides** executable
//! price for leg selection.
//!
//! ### Price doctrine
//! ```text
//! best_buy  = min(valid_rows, key=lambda r: r.buy_price_executable_usd_per_base)
//! best_sell = max(valid_rows, key=lambda r: r.sell_price_executable_usd_per_base)
//! ```
//! No metadata field, protocol tag, venue, or router type may override this.

use adapters::{PoolQuote, Protocol};
use serde::{Deserialize, Serialize};

/// Chain ID for all valid Polygon PoS candidates.
pub const POLYGON_CHAIN_ID: u64 = 137;
/// Minimum pool TVL in USD required for a valid candidate.
pub const MIN_POOL_TVL_USD: f64 = 50_000.0;

// ─── CandidateRow ─────────────────────────────────────────────────────────────

/// A single pool quote row — raw DNA, fully preserved.
///
/// This is the leaf-level record.  The ranking engine selects the best buy and
/// sell from a collection of these rows; it never mutates them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CandidateRow {
    // ── Identity ──────────────────────────────────────────────────────────────
    pub chain_id: u64,
    pub protocol: Protocol,
    pub pool_address: String,

    // ── Token metadata (DNA) ─────────────────────────────────────────────────
    pub base_token_symbol: String,
    pub quote_token_symbol: String,
    pub base_token_address: String,
    pub quote_token_address: String,
    pub base_decimals: u8,
    pub quote_decimals: u8,

    // ── Executable price — the ONLY ranking authority ─────────────────────────
    /// Executable buy price: quote tokens received per base token sold.
    /// Lower is better for a buy leg.
    pub buy_price_executable_usd_per_base: f64,
    /// Executable sell price: base tokens received per quote token sold.
    /// Higher is better for a sell leg.
    pub sell_price_executable_usd_per_base: f64,

    // ── Quote provenance (DNA) ────────────────────────────────────────────────
    pub amount_in_raw: u128,
    pub amount_out_raw: u128,
    pub fee_ppm: u32,
    pub pool_tvl_usd: f64,
    pub timestamp_ms: u64,

    // ── Protocol-specific metadata (DNA, read-only) ───────────────────────────
    pub reserve_base_raw: Option<u128>,
    pub reserve_quote_raw: Option<u128>,
    pub sqrt_price_x96: Option<u128>,
}

impl CandidateRow {
    /// Construct a `CandidateRow` from a [`PoolQuote`].
    ///
    /// Both executable prices are derived from `quote.executable_price`.
    /// The buy price is the cost to acquire one base token (lower = cheaper),
    /// and the sell price is the revenue from selling one base token (higher = more).
    pub fn from_quote(quote: &PoolQuote) -> Self {
        // executable_price = amountOut_human / amountIn_human
        // For a buy:  price of base in quote terms = quote.executable_price
        // For a sell: price of base in quote terms = quote.executable_price
        // The ranker picks best_buy = min(buy_price), best_sell = max(sell_price)
        let ep = quote.executable_price;
        CandidateRow {
            chain_id: quote.chain_id,
            protocol: quote.protocol,
            pool_address: quote.pool_address.clone(),
            base_token_symbol: quote.base_token.clone(),
            quote_token_symbol: quote.quote_token.clone(),
            base_token_address: quote.base_token_address.clone(),
            quote_token_address: quote.quote_token_address.clone(),
            base_decimals: quote.base_decimals,
            quote_decimals: quote.quote_decimals,
            buy_price_executable_usd_per_base: ep,
            sell_price_executable_usd_per_base: ep,
            amount_in_raw: quote.amount_in_raw,
            amount_out_raw: quote.amount_out_raw,
            fee_ppm: quote.fee_ppm,
            pool_tvl_usd: quote.pool_tvl_usd,
            timestamp_ms: quote.timestamp_ms,
            reserve_base_raw: quote.reserve_base_raw,
            reserve_quote_raw: quote.reserve_quote_raw,
            sqrt_price_x96: quote.sqrt_price_x96,
        }
    }
}

// ─── ArbitrageCandidate ───────────────────────────────────────────────────────

/// A validated, ranked arbitrage candidate.
///
/// Derived from selecting the best buy and sell rows in a collection of
/// [`CandidateRow`] values for the same base/quote pair.
///
/// ### Selection law (immutable canon)
/// ```text
/// best_buy  = row with min(buy_price_executable_usd_per_base)
/// best_sell = row with max(sell_price_executable_usd_per_base)
/// ```
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArbitrageCandidate {
    // ── Pair identification ───────────────────────────────────────────────────
    pub chain_id: u64,
    pub base_token_symbol: String,
    pub quote_token_symbol: String,
    pub base_token_address: String,
    pub quote_token_address: String,

    // ── Selected legs (price-ranked only) ────────────────────────────────────
    pub best_buy: CandidateRow,
    pub best_sell: CandidateRow,

    // ── Computed spread ───────────────────────────────────────────────────────
    /// Executable spread: (sell_price − buy_price) / buy_price.
    pub spread: f64,
    /// Gross profit estimate in quote-token units per base unit traded.
    pub gross_profit_per_unit: f64,

    // ── Scan provenance ───────────────────────────────────────────────────────
    /// Number of comparable destinations considered (must be ≥ 2 to be valid).
    pub num_destinations: usize,
    pub scan_timestamp_ms: u64,
}

// ─── ScanSummary ──────────────────────────────────────────────────────────────

/// Statistics for a single scan pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanSummary {
    pub chain_id: u64,
    pub scan_timestamp_ms: u64,
    /// Total pool quotes collected.
    pub total_quotes: usize,
    /// Quotes rejected because chain_id ≠ 137.
    pub rejected_wrong_chain: usize,
    /// Quotes rejected because TVL < `MIN_POOL_TVL_USD`.
    pub rejected_low_tvl: usize,
    /// Quotes rejected because no live executable price was available.
    pub rejected_no_price: usize,
    /// Pairs that passed all gates and produced a valid candidate.
    pub valid_candidates: usize,
    /// Pairs that had fewer than 2 comparable destinations.
    pub rejected_insufficient_destinations: usize,
    /// Same-pool round-trips rejected.
    pub rejected_same_pool: usize,
}

// ─── ScanResult ───────────────────────────────────────────────────────────────

/// Complete output of one scan pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub summary: ScanSummary,
    /// All valid candidates, sorted by spread descending.
    pub candidates: Vec<ArbitrageCandidate>,
}

impl ScanResult {
    /// Best candidate (highest spread), if any.
    pub fn best(&self) -> Option<&ArbitrageCandidate> {
        self.candidates.first()
    }

    /// Serialize to compact JSON.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }

    /// Serialize to pretty-printed JSON.
    pub fn to_json_pretty(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adapters::{PoolQuote, SwapDirection};

    fn make_quote(pool: &str, price: f64, tvl: f64) -> PoolQuote {
        PoolQuote {
            chain_id: 137,
            protocol: Protocol::QuickSwapV2,
            pool_address: pool.to_string(),
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
            timestamp_ms: 1_000_000,
            reserve_base_raw: Some(10_000_000_000_000_000_000_000),
            reserve_quote_raw: Some(8_000_000_000),
            sqrt_price_x96: None,
            direction: SwapDirection::ZeroForOne,
        }
    }

    #[test]
    fn test_candidate_row_from_quote() {
        let q = make_quote("0xpool", 0.85, 100_000.0);
        let row = CandidateRow::from_quote(&q);
        assert_eq!(row.chain_id, 137);
        assert!((row.buy_price_executable_usd_per_base - 0.85).abs() < 1e-9);
        assert!((row.sell_price_executable_usd_per_base - 0.85).abs() < 1e-9);
    }

    #[test]
    fn test_scan_result_serialisation() {
        let result = ScanResult {
            summary: ScanSummary {
                chain_id: 137,
                scan_timestamp_ms: 0,
                total_quotes: 0,
                rejected_wrong_chain: 0,
                rejected_low_tvl: 0,
                rejected_no_price: 0,
                valid_candidates: 0,
                rejected_insufficient_destinations: 0,
                rejected_same_pool: 0,
            },
            candidates: vec![],
        };
        let json = result.to_json().expect("serialisation failed");
        assert!(json.contains("\"chain_id\":137"));
    }
}
