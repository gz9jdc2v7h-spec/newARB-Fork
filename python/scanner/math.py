"""
Fixed-point CFMM math helpers — thin wrappers over the Rust extension.

Falls back to pure-Python implementations when the Rust extension is not
installed, so the module is always importable.
"""

from __future__ import annotations

try:
    import scanner_pyo3 as _rust  # type: ignore[import]
    _RUST_AVAILABLE = True
except ImportError:
    _RUST_AVAILABLE = False


# ─── Exported math functions ──────────────────────────────────────────────────

def cfmm_amount_out(
    reserve_in: int,
    reserve_out: int,
    amount_in: int,
    fee_bps: int,
) -> int:
    """Exact constant-product output amount.

    Uses Rust fixed-point arithmetic when available, otherwise falls back to
    the Python equivalent.

    Args:
        reserve_in:  Pool reserve of the input token (raw units).
        reserve_out: Pool reserve of the output token (raw units).
        amount_in:   Trade size (raw units).
        fee_bps:     Fee in basis points (e.g. 30 for 0.3 %).

    Returns:
        Output amount in raw token units.
    """
    if _RUST_AVAILABLE:
        return _rust.cfmm_amount_out(reserve_in, reserve_out, amount_in, fee_bps)
    return _py_cfmm_amount_out(reserve_in, reserve_out, amount_in, fee_bps)


def cfmm_optimal_input(
    r1: int, s1: int, fee1: int,
    r2: int, s2: int, fee2: int,
) -> int:
    """Closed-form optimal two-pool input x*.

    Args:
        r1, s1: Reserves of pool 1 (sell leg): r1=reserveIn, s1=reserveOut.
        fee1:   Fee in basis points for pool 1.
        r2, s2: Reserves of pool 2 (buy-back leg): r2=reserveOut, s2=reserveIn.
        fee2:   Fee in basis points for pool 2.

    Returns:
        Optimal input in raw token units, or 0 if no profitable arb.
    """
    if _RUST_AVAILABLE:
        return _rust.cfmm_optimal_input(r1, s1, fee1, r2, s2, fee2)
    return _py_cfmm_optimal_input(r1, s1, fee1, r2, s2, fee2)


def cfmm_arb_profit(
    x: int,
    r1: int, s1: int, fee1: int,
    r2: int, s2: int, fee2: int,
) -> int:
    """Two-pool arbitrage profit at input x.

    Returns:
        Profit in raw token units, or 0 if unprofitable.
    """
    if _RUST_AVAILABLE:
        return _rust.cfmm_arb_profit(x, r1, s1, fee1, r2, s2, fee2)
    y = _py_cfmm_amount_out(r1, s1, x, fee1)
    if y == 0:
        return 0
    z = _py_cfmm_amount_out(r2, s2, y, fee2)
    return max(0, z - x)


# ─── Pure Python fallbacks ────────────────────────────────────────────────────

_FEE_DENOM = 1_000_000


def _py_cfmm_amount_out(
    reserve_in: int,
    reserve_out: int,
    amount_in: int,
    fee_bps: int,
) -> int:
    if reserve_in == 0 or reserve_out == 0 or amount_in == 0:
        return 0
    gamma_n = _FEE_DENOM - fee_bps * 100
    numerator = reserve_out * gamma_n * amount_in
    denominator = reserve_in * _FEE_DENOM + gamma_n * amount_in
    return numerator // denominator if denominator else 0


def _py_isqrt(n: int) -> int:
    if n < 2:
        return n
    x = n
    y = (x + 1) // 2
    while y < x:
        x = y
        y = (x + n // x) // 2
    return x


def _py_cfmm_optimal_input(
    r1: int, s1: int, fee1: int,
    r2: int, s2: int, fee2: int,
) -> int:
    if r1 == 0 or s1 == 0 or r2 == 0 or s2 == 0:
        return 0
    g1 = _FEE_DENOM - fee1 * 100
    g2 = _FEE_DENOM - fee2 * 100
    radicand = s1 * s2 * g1 * g2 * r1 * r2
    sqrt_term = _py_isqrt(radicand)
    baseline = r1 * r2 * _FEE_DENOM
    if sqrt_term <= baseline:
        return 0
    numerator = _FEE_DENOM * (sqrt_term - baseline)
    denominator = g1 * (r2 * _FEE_DENOM + s1 * g2)
    return numerator // denominator if denominator else 0
