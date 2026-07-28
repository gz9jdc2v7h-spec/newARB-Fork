"""
Python type definitions mirroring the Rust output schema.

These are thin dataclasses used for IDE autocompletion and type-safety when
working with deserialized scanner output.  They are not required for runtime
operation — `Scanner` returns plain dicts when the Rust extension is absent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class RawQuote:
    """A single raw pool quote as consumed by the Rust validator.

    All fields match the Rust ``PoolQuote`` struct serialized to JSON.
    """

    chain_id: int
    protocol: str  # snake_case, e.g. "quick_swap_v2"
    pool_address: str
    base_token: str
    quote_token: str
    base_token_address: str
    quote_token_address: str
    base_decimals: int
    quote_decimals: int
    amount_in_raw: int
    amount_out_raw: int
    executable_price: float
    fee_ppm: int
    pool_tvl_usd: float
    timestamp_ms: int
    direction: str  # "zero_for_one" or "one_for_zero"
    reserve_base_raw: Optional[int] = None
    reserve_quote_raw: Optional[int] = None
    sqrt_price_x96: Optional[int] = None

    def to_dict(self) -> dict:
        """Convert to a plain dict suitable for JSON serialization."""
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class CandidateRow:
    """Validated pool quote row — origin DNA fully preserved."""

    chain_id: int
    protocol: str
    pool_address: str
    base_token_symbol: str
    quote_token_symbol: str
    base_token_address: str
    quote_token_address: str
    base_decimals: int
    quote_decimals: int
    buy_price_executable_usd_per_base: float
    sell_price_executable_usd_per_base: float
    amount_in_raw: int
    amount_out_raw: int
    fee_ppm: int
    pool_tvl_usd: float
    timestamp_ms: int
    reserve_base_raw: Optional[int] = None
    reserve_quote_raw: Optional[int] = None
    sqrt_price_x96: Optional[int] = None

    @classmethod
    def from_dict(cls, d: dict) -> "CandidateRow":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__ if k in d})


@dataclass
class ArbitrageCandidate:
    """Validated, ranked arbitrage candidate."""

    chain_id: int
    base_token_symbol: str
    quote_token_symbol: str
    base_token_address: str
    quote_token_address: str
    best_buy: CandidateRow
    best_sell: CandidateRow
    spread: float
    gross_profit_per_unit: float
    num_destinations: int
    scan_timestamp_ms: int

    @classmethod
    def from_dict(cls, d: dict) -> "ArbitrageCandidate":
        return cls(
            chain_id=d["chain_id"],
            base_token_symbol=d["base_token_symbol"],
            quote_token_symbol=d["quote_token_symbol"],
            base_token_address=d["base_token_address"],
            quote_token_address=d["quote_token_address"],
            best_buy=CandidateRow.from_dict(d["best_buy"]),
            best_sell=CandidateRow.from_dict(d["best_sell"]),
            spread=d["spread"],
            gross_profit_per_unit=d["gross_profit_per_unit"],
            num_destinations=d["num_destinations"],
            scan_timestamp_ms=d["scan_timestamp_ms"],
        )


@dataclass
class ScanSummary:
    """Statistics for one scan pass."""

    chain_id: int
    scan_timestamp_ms: int
    total_quotes: int
    rejected_wrong_chain: int
    rejected_low_tvl: int
    rejected_no_price: int
    valid_candidates: int
    rejected_insufficient_destinations: int
    rejected_same_pool: int

    @classmethod
    def from_dict(cls, d: dict) -> "ScanSummary":
        return cls(**d)


@dataclass
class ScanResult:
    """Complete output of one scan pass."""

    summary: ScanSummary
    candidates: list[ArbitrageCandidate] = field(default_factory=list)

    @property
    def best(self) -> Optional[ArbitrageCandidate]:
        """Best candidate (highest spread), or None."""
        return self.candidates[0] if self.candidates else None

    @classmethod
    def from_dict(cls, d: dict) -> "ScanResult":
        return cls(
            summary=ScanSummary.from_dict(d["summary"]),
            candidates=[ArbitrageCandidate.from_dict(c) for c in d.get("candidates", [])],
        )
