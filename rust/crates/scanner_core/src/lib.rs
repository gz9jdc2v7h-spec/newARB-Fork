//! # scanner_core
//!
//! Core domain types, output schema, and scan-level orchestration for the
//! Apex-Omega Chain-42161 (Arbitrum One) scanner.
//!
//! ## Output schema
//!
//! The canonical output is a [`ScanResult`] containing zero or more
//! [`ArbitrageCandidate`] values, each derived from a [`CandidateRow`].
//!
//! `CandidateRow` ↔ raw per-pool quote (DNA / provenance metadata fully preserved)
//! `ArbitrageCandidate` ↔ validated, ranked buy+sell pair
//! `ScanResult` ↔ full scan output (candidates + metadata)

pub mod schema;

pub use schema::{ArbitrageCandidate, CandidateRow, ScanResult, ScanSummary};
pub use schema::{ARBITRUM_CHAIN_ID, MIN_POOL_TVL_USD};
