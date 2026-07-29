"""
Scanner — main entry point.

Wraps the Rust/PyO3 ``scanner_pyo3`` extension for Python callers.
Falls back to the pure-Python pipeline when the extension is not installed.
"""

from __future__ import annotations

import json
import time
from typing import Any, Sequence

from scanner.types import RawQuote, ScanResult

try:
    import scanner_pyo3 as _rust  # type: ignore[import]
    _RUST_AVAILABLE = True
except ImportError:
    _RUST_AVAILABLE = False


class Scanner:
    """Apex-Omega Chain-42161 (Arbitrum One) scanner.

    Validates and ranks a batch of raw pool quotes using the executable-price
    doctrine.

    Example::

        from scanner import Scanner
        scanner = Scanner()
        result = scanner.scan(quotes)
        print(result.best.spread if result.best else "no candidates")
    """

    def scan(
        self,
        quotes: Sequence[RawQuote | dict[str, Any]],
        timestamp_ms: int | None = None,
    ) -> ScanResult:
        """Run the full validate-then-rank pipeline.

        Args:
            quotes:       Iterable of :class:`RawQuote` objects or plain dicts.
            timestamp_ms: Scan timestamp (ms).  Defaults to ``time.time_ns()//1_000_000``.

        Returns:
            A :class:`ScanResult` containing all valid candidates sorted by
            spread descending.
        """
        ts = timestamp_ms if timestamp_ms is not None else time.time_ns() // 1_000_000

        # Normalise to plain dicts
        raw_dicts = [
            q.to_dict() if isinstance(q, RawQuote) else q
            for q in quotes
        ]
        quotes_json = json.dumps(raw_dicts)

        if _RUST_AVAILABLE:
            result_json = _rust.scan_batch_json(quotes_json, ts)
            return ScanResult.from_dict(json.loads(result_json))

        # Pure-Python fallback pipeline
        return self._py_scan(raw_dicts, ts)

    # ─── Pure-Python fallback ─────────────────────────────────────────────────

    def _py_scan(
        self,
        raw_dicts: list[dict[str, Any]],
        timestamp_ms: int,
    ) -> ScanResult:
        """Fallback scanner implemented entirely in Python.

        Mirrors the Rust gate logic so the module is usable without the
        compiled extension (e.g. in Colab before the wheel is built).
        """
        from scanner.types import (
            ArbitrageCandidate, CandidateRow, ScanSummary,
        )

        ARBITRUM_CHAIN_ID = 42161
        MIN_POOL_TVL_USD = 50_000.0

        total = len(raw_dicts)
        wrong_chain = low_tvl = no_price = 0
        valid_rows: list[CandidateRow] = []

        for q in raw_dicts:
            if q.get("chain_id") != ARBITRUM_CHAIN_ID:
                wrong_chain += 1
                continue
            tvl = q.get("pool_tvl_usd", 0.0) or 0.0
            if tvl < MIN_POOL_TVL_USD:
                low_tvl += 1
                continue
            price = q.get("executable_price", 0.0) or 0.0
            if price <= 0.0:
                no_price += 1
                continue
            row = CandidateRow(
                chain_id=q["chain_id"],
                protocol=q.get("protocol", ""),
                pool_address=q.get("pool_address", ""),
                base_token_symbol=q.get("base_token", q.get("base_token_symbol", "")),
                quote_token_symbol=q.get("quote_token", q.get("quote_token_symbol", "")),
                base_token_address=q.get("base_token_address", ""),
                quote_token_address=q.get("quote_token_address", ""),
                base_decimals=q.get("base_decimals", 18),
                quote_decimals=q.get("quote_decimals", 6),
                buy_price_executable_usd_per_base=price,
                sell_price_executable_usd_per_base=price,
                amount_in_raw=q.get("amount_in_raw", 0),
                amount_out_raw=q.get("amount_out_raw", 0),
                fee_ppm=q.get("fee_ppm", 3000),
                pool_tvl_usd=tvl,
                timestamp_ms=q.get("timestamp_ms", timestamp_ms),
                reserve_base_raw=q.get("reserve_base_raw"),
                reserve_quote_raw=q.get("reserve_quote_raw"),
                sqrt_price_x96=q.get("sqrt_price_x96"),
            )
            valid_rows.append(row)

        # Group by pair
        from collections import defaultdict
        pairs: dict[tuple[str, str], list[CandidateRow]] = defaultdict(list)
        for row in valid_rows:
            pairs[(row.base_token_address, row.quote_token_address)].append(row)

        candidates: list[ArbitrageCandidate] = []
        insufficient = same_pool = 0

        for (base_addr, quote_addr), rows in pairs.items():
            valid = [r for r in rows if r.buy_price_executable_usd_per_base > 0.0]
            if len(valid) < 2:
                insufficient += 1
                continue
            # Selection law: price only
            best_buy = min(valid, key=lambda r: r.buy_price_executable_usd_per_base)
            best_sell = max(valid, key=lambda r: r.sell_price_executable_usd_per_base)
            if best_buy.pool_address.lower() == best_sell.pool_address.lower():
                same_pool += 1
                continue
            bp = best_buy.buy_price_executable_usd_per_base
            sp = best_sell.sell_price_executable_usd_per_base
            if sp <= bp:
                continue
            candidates.append(ArbitrageCandidate(
                chain_id=ARBITRUM_CHAIN_ID,
                base_token_symbol=rows[0].base_token_symbol,
                quote_token_symbol=rows[0].quote_token_symbol,
                base_token_address=base_addr,
                quote_token_address=quote_addr,
                best_buy=best_buy,
                best_sell=best_sell,
                spread=(sp - bp) / bp,
                gross_profit_per_unit=sp - bp,
                num_destinations=len(valid),
                scan_timestamp_ms=timestamp_ms,
            ))

        candidates.sort(key=lambda c: c.spread, reverse=True)

        return ScanResult(
            summary=ScanSummary(
                chain_id=ARBITRUM_CHAIN_ID,
                scan_timestamp_ms=timestamp_ms,
                total_quotes=total,
                rejected_wrong_chain=wrong_chain,
                rejected_low_tvl=low_tvl,
                rejected_no_price=no_price,
                valid_candidates=len(candidates),
                rejected_insufficient_destinations=insufficient,
                rejected_same_pool=same_pool,
            ),
            candidates=candidates,
        )
