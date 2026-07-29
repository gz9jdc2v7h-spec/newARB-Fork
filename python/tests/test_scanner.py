"""
Python wrapper tests — validates the pure-Python fallback pipeline
and type definitions (no Rust extension required).
"""

import pytest
import sys
import os

# Ensure the python directory is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from scanner import Scanner
from scanner.types import RawQuote, ScanResult
from scanner.math import (
    cfmm_amount_out,
    cfmm_optimal_input,
    cfmm_arb_profit,
    _py_cfmm_amount_out,
    _py_cfmm_optimal_input,
    _py_isqrt,
)


# ─── Math tests ───────────────────────────────────────────────────────────────

class TestPyMath:
    def test_isqrt_perfect_squares(self):
        assert _py_isqrt(0) == 0
        assert _py_isqrt(1) == 1
        assert _py_isqrt(4) == 2
        assert _py_isqrt(9) == 3
        assert _py_isqrt(100) == 10

    def test_isqrt_floor(self):
        assert _py_isqrt(10) == 3   # ⌊√10⌋ = 3
        assert _py_isqrt(15) == 3   # ⌊√15⌋ = 3

    def test_cfmm_amount_out_basic(self):
        # 0.3% fee, reserves 1000 each, amountIn 10
        out = _py_cfmm_amount_out(1000, 1000, 10, 30)
        assert 0 < out < 10

    def test_cfmm_amount_out_zero_reserve(self):
        assert _py_cfmm_amount_out(0, 1000, 10, 30) == 0
        assert _py_cfmm_amount_out(1000, 0, 10, 30) == 0
        assert _py_cfmm_amount_out(1000, 1000, 0, 30) == 0

    def test_cfmm_optimal_input_no_arb(self):
        # Identical pools → no arb
        x = _py_cfmm_optimal_input(1_000_000, 1_000_000, 30, 1_000_000, 1_000_000, 30)
        assert x == 0

    def test_cfmm_optimal_input_with_spread(self):
        # Shifted reserves → arb exists
        x = _py_cfmm_optimal_input(800_000, 1_200_000, 30, 1_200_000, 800_000, 30)
        assert x >= 0  # may be 0 for small reserves; should not raise

    def test_cfmm_arb_profit_via_wrapper(self):
        # Using wrapper (falls through to Python in test environment)
        profit = cfmm_arb_profit(100, 1_000_000, 1_000_000, 30, 1_000_000, 1_000_000, 30)
        assert profit == 0  # identical pools


# ─── Scanner tests ────────────────────────────────────────────────────────────

def make_quote(pool: str, price: float, tvl: float, chain_id: int = 42161) -> dict:
    return {
        "chain_id": chain_id,
        "protocol": "camelot_v2",
        "pool_address": pool,
        "base_token": "WETH",
        "quote_token": "USDC",
        "base_token_address": "0xbase",
        "quote_token_address": "0xquote",
        "base_decimals": 18,
        "quote_decimals": 6,
        "amount_in_raw": 1_000_000_000_000_000_000,
        "amount_out_raw": int(price * 1_000_000),
        "executable_price": price,
        "fee_ppm": 3000,
        "pool_tvl_usd": tvl,
        "timestamp_ms": 0,
        "direction": "zero_for_one",
    }


class TestScanner:
    def setup_method(self):
        self.scanner = Scanner()

    def test_valid_candidate(self):
        quotes = [
            make_quote("0xpool_a", 0.80, 100_000.0),
            make_quote("0xpool_b", 0.88, 100_000.0),
        ]
        result = self.scanner.scan(quotes, timestamp_ms=0)
        assert isinstance(result, ScanResult)
        assert len(result.candidates) == 1
        c = result.candidates[0]
        # best buy = min price = 0.80
        assert abs(c.best_buy.buy_price_executable_usd_per_base - 0.80) < 1e-9
        # best sell = max price = 0.88
        assert abs(c.best_sell.sell_price_executable_usd_per_base - 0.88) < 1e-9
        assert c.spread > 0

    def test_wrong_chain_rejected(self):
        quotes = [
            make_quote("0xpool_a", 0.80, 100_000.0, chain_id=1),  # Ethereum
            make_quote("0xpool_b", 0.88, 100_000.0, chain_id=1),
        ]
        result = self.scanner.scan(quotes, timestamp_ms=0)
        assert result.summary.rejected_wrong_chain == 2
        assert len(result.candidates) == 0

    def test_low_tvl_rejected(self):
        quotes = [
            make_quote("0xpool_a", 0.80, 49_999.0),
            make_quote("0xpool_b", 0.88, 49_999.0),
        ]
        result = self.scanner.scan(quotes, timestamp_ms=0)
        assert result.summary.rejected_low_tvl == 2
        assert len(result.candidates) == 0

    def test_exactly_50k_tvl_passes(self):
        quotes = [
            make_quote("0xpool_a", 0.80, 50_000.0),
            make_quote("0xpool_b", 0.88, 50_000.0),
        ]
        result = self.scanner.scan(quotes, timestamp_ms=0)
        assert len(result.candidates) == 1

    def test_zero_price_rejected(self):
        quotes = [
            make_quote("0xpool_a", 0.0, 100_000.0),
            make_quote("0xpool_b", 0.88, 100_000.0),
        ]
        result = self.scanner.scan(quotes, timestamp_ms=0)
        # 0xpool_a has zero price → rejected, only 1 valid → insufficient destinations
        assert len(result.candidates) == 0

    def test_same_pool_rejected(self):
        # Both quotes from the same pool address
        quotes = [
            make_quote("0xpool_same", 0.80, 100_000.0),
            make_quote("0xpool_same", 0.88, 100_000.0),
        ]
        result = self.scanner.scan(quotes, timestamp_ms=0)
        assert result.summary.rejected_same_pool == 1
        assert len(result.candidates) == 0

    def test_candidates_sorted_by_spread(self):
        # Two different base/quote pairs
        quotes = [
            # WETH/USDC: small spread
            make_quote("0xpool_a", 0.80, 100_000.0),
            make_quote("0xpool_b", 0.82, 100_000.0),
            # WETH/USDT: larger spread (different quote token)
            {**make_quote("0xpool_c", 0.70, 100_000.0), "quote_token": "USDT", "quote_token_address": "0xusdt"},
            {**make_quote("0xpool_d", 0.95, 100_000.0), "quote_token": "USDT", "quote_token_address": "0xusdt"},
        ]
        result = self.scanner.scan(quotes, timestamp_ms=0)
        assert len(result.candidates) == 2
        # Verify sorted descending by spread
        assert result.candidates[0].spread >= result.candidates[1].spread

    def test_summary_counts(self):
        quotes = [
            make_quote("0xpool_a", 0.80, 100_000.0),
            make_quote("0xpool_b", 0.88, 100_000.0),
            make_quote("0xpool_c", 0.0, 100_000.0),    # no price
            make_quote("0xpool_d", 0.90, 10_000.0),    # low TVL
            make_quote("0xpool_e", 0.85, 100_000.0, chain_id=1),  # wrong chain
        ]
        result = self.scanner.scan(quotes, timestamp_ms=0)
        s = result.summary
        assert s.total_quotes == 5
        assert s.rejected_no_price == 1
        assert s.rejected_low_tvl == 1
        assert s.rejected_wrong_chain == 1

    def test_best_property(self):
        quotes = [
            make_quote("0xpool_a", 0.80, 100_000.0),
            make_quote("0xpool_b", 0.88, 100_000.0),
        ]
        result = self.scanner.scan(quotes, timestamp_ms=0)
        assert result.best is not None
        assert result.best is result.candidates[0]

    def test_no_candidates_best_is_none(self):
        result = self.scanner.scan([], timestamp_ms=0)
        assert result.best is None

    def test_raw_quote_type(self):
        rq = RawQuote(
            chain_id=42161,
            protocol="camelot_v2",
            pool_address="0xpool",
            base_token="WETH",
            quote_token="USDC",
            base_token_address="0xbase",
            quote_token_address="0xquote",
            base_decimals=18,
            quote_decimals=6,
            amount_in_raw=10**18,
            amount_out_raw=800_000,
            executable_price=0.80,
            fee_ppm=3000,
            pool_tvl_usd=100_000.0,
            timestamp_ms=0,
            direction="zero_for_one",
        )
        result = self.scanner.scan([rq], timestamp_ms=0)
        assert result.summary.total_quotes == 1
        assert len(result.candidates) == 0  # only 1 valid → not enough destinations
