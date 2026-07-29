"""
Apex-Omega Chain-42161 (Arbitrum One) Scanner — Python wrapper.

This package wraps the Rust/PyO3 `scanner_pyo3` extension module with a
Pythonic API.  Install the Rust extension with::

    cd rust && maturin develop --manifest-path crates/scanner_pyo3/Cargo.toml

or build a wheel::

    maturin build --release --manifest-path rust/crates/scanner_pyo3/Cargo.toml

Usage::

    from scanner import Scanner

    scanner = Scanner()
    result = scanner.scan(quotes)  # list of raw quote dicts
    for candidate in result.candidates:
        print(candidate.spread, candidate.best_buy.pool_address)
"""

from scanner.scanner import Scanner
from scanner.types import (
    RawQuote,
    CandidateRow,
    ArbitrageCandidate,
    ScanResult,
    ScanSummary,
)
from scanner.math import (
    cfmm_amount_out,
    cfmm_optimal_input,
    cfmm_arb_profit,
)

__all__ = [
    "Scanner",
    "RawQuote",
    "CandidateRow",
    "ArbitrageCandidate",
    "ScanResult",
    "ScanSummary",
    "cfmm_amount_out",
    "cfmm_optimal_input",
    "cfmm_arb_profit",
]
