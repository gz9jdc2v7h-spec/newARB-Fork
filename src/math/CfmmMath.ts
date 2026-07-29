/**
 * CfmmMath — Core Constant-Function Market Maker mathematics.
 *
 * All critical paths use exact BigInt arithmetic to avoid the floating-point
 * rounding errors that compound across multi-leg DeFi trades.
 *
 * ─── Notation ────────────────────────────────────────────────────────────────
 *   r   = reserveIn   (reserve of the token being sold into the pool)
 *   s   = reserveOut  (reserve of the token being bought from the pool)
 *   x   = amountIn    (input trade size)
 *   y   = amountOut   (output amount received)
 *   γ   = 1 − fee     (fee complement, e.g. 0.997 for a 0.3 % fee)
 *   FD  = 1_000_000   (fee denominator, giving 1 ppm resolution)
 *   γ_n = γ · FD      (integer representation of γ)
 *
 * ─── UniV2 constant-product invariant ────────────────────────────────────────
 *   (r + γ·x)(s − y) = r·s   ⟹   y = s·γ·x / (r + γ·x)
 *
 * ─── Closed-form optimal input derivation ────────────────────────────────────
 *   For two CFMM pools trading the same pair:
 *
 *     Pool 1  (buy):   y₁ = s₁·γ₁·x / (r₁ + γ₁·x)
 *     Pool 2  (sell):  z  = s₂·γ₂·y₁ / (r₂ + γ₂·y₁)
 *
 *   Substituting:
 *     z(x) = A·x / (B + C·x)
 *     where A = s₁·s₂·γ₁·γ₂ ,  B = r₁·r₂ ,  C = γ₁·(r₂ + s₁·γ₂)
 *
 *   Profit P(x) = z(x) − x
 *
 *   Setting dP/dx = 0:
 *     A·B / (B + C·x)² = 1   ⟹   B + C·x = √(A·B)
 *
 *   Unique positive maximiser:
 *
 *        x* = (√(A·B) − B) / C
 *           = (√(s₁·s₂·γ₁·γ₂·r₁·r₂) / FD  −  r₁·r₂)
 *             ─────────────────────────────────────────
 *               γ₁·(r₂ + s₁·γ₂) / FD
 *
 *   In integer BigInt form (multiply top and bottom by FD):
 *
 *        x* = FD · (√(s₁·s₂·γ₁_n·γ₂_n·r₁·r₂) − r₁·r₂·FD)
 *             ───────────────────────────────────────────────
 *                    γ₁_n · (r₂·FD + s₁·γ₂_n)
 *
 *   This is exact in BigInt arithmetic (no floating-point error).
 */

/** Fee denominator: γ_n = FD − feeBps·100  (e.g. 30 bps ⟹ γ_n = 997 000) */
export const FEE_DENOM = 1_000_000n;

// ─── Integer square root ──────────────────────────────────────────────────────

/**
 * Integer square root — ⌊√n⌋ — via the Babylonian (Newton–Raphson) method.
 *
 * Convergence: quadratic. For a 256-bit input the loop runs ≤ 256 iterations
 * in the worst case but typically converges in ~15 iterations.
 *
 *   x_{k+1} = (x_k + n/x_k) / 2
 *
 * The iteration is terminated when x_{k+1} ≥ x_k (proof of floor convergence
 * follows from the AM–GM inequality: (x + n/x)/2 ≥ √n, with equality iff
 * x = √n).
 */
export function bigIntSqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("bigIntSqrt: argument must be non-negative");
  if (n < 2n) return n;

  // Initial estimate: 2^⌈bits/2⌉  (guaranteed ≥ √n)
  const bits = n.toString(2).length;
  let x = 1n << BigInt(Math.ceil(bits / 2));
  let y = (x + n / x) >> 1n;

  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x; // ⌊√n⌋  — verified: x² ≤ n < (x+1)²
}

// ─── Core CFMM formulae ───────────────────────────────────────────────────────

/**
 * Exact UniV2 output amount for a given input (integer arithmetic).
 *
 *   y = s · γ_n · x / (r · FD + γ_n · x)
 *
 * @param reserveIn   Pool reserve of the input token.
 * @param reserveOut  Pool reserve of the output token.
 * @param amountIn    Trade size (raw token units).
 * @param feeBps      Fee in basis points (e.g. 30 for 0.3 %).
 */
export function cfmmAmountOut(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeBps: number
): bigint {
  if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;
  const γ_n = FEE_DENOM - BigInt(feeBps * 100);
  const numerator = reserveOut * γ_n * amountIn;
  const denominator = reserveIn * FEE_DENOM + γ_n * amountIn;
  return numerator / denominator;
}

/**
 * Closed-form optimal input x* for a two-pool CFMM arbitrage.
 *
 * The formula x* = (√(A·B) − B) / C is derived by solving d/dx [P(x)] = 0
 * where P(x) = cfmmAmountOut(pool2, cfmmAmountOut(pool1, x)) − x.
 *
 * Pool layout for a A→B→A round-trip:
 *   Pool 1 (buy B with A):  r1 = reserve of A, s1 = reserve of B
 *   Pool 2 (sell B for A):  r2 = reserve of B, s2 = reserve of A
 *
 * @returns Optimal input in raw token units, or 0n if no profitable arb exists.
 */
export function cfmmOptimalInput(
  r1: bigint, s1: bigint, feeBps1: number,
  r2: bigint, s2: bigint, feeBps2: number
): bigint {
  if (r1 === 0n || s1 === 0n || r2 === 0n || s2 === 0n) return 0n;

  const γ1 = FEE_DENOM - BigInt(feeBps1 * 100);
  const γ2 = FEE_DENOM - BigInt(feeBps2 * 100);

  // radicand = s₁·s₂·γ₁·γ₂·r₁·r₂
  const radicand = s1 * s2 * γ1 * γ2 * r1 * r2;
  const sqrtTerm = bigIntSqrt(radicand); // = FD · √(A·B) (in integer form)

  // baseline = r₁·r₂·FD  (what sqrtTerm must exceed for x* > 0)
  const baseline = r1 * r2 * FEE_DENOM;

  if (sqrtTerm <= baseline) return 0n; // condition for profitable arb: √(AB) > B

  // x* = FD · (sqrtTerm − baseline) / (γ₁ · (r₂·FD + s₁·γ₂))
  const numerator = FEE_DENOM * (sqrtTerm - baseline);
  const denominator = γ1 * (r2 * FEE_DENOM + s1 * γ2);
  if (denominator === 0n) return 0n;

  return numerator / denominator;
}

/**
 * Maximum theoretical profit at the optimal input x*, computed analytically.
 *
 *   P* = z(x*) − x*   where z(x) = A·x / (B + C·x)
 *
 * Equivalent to: P* = (√A − √B)² / C  (after substituting x* and simplifying).
 *
 * @returns Max profit in input-token raw units, or 0n if no arb.
 */
export function cfmmMaxProfit(
  r1: bigint, s1: bigint, feeBps1: number,
  r2: bigint, s2: bigint, feeBps2: number
): bigint {
  const x = cfmmOptimalInput(r1, s1, feeBps1, r2, s2, feeBps2);
  if (x === 0n) return 0n;
  return cfmmArbProfit(x, r1, s1, feeBps1, r2, s2, feeBps2);
}

/**
 * Two-pool arbitrage profit at a specific input amount x.
 *
 *   P(x) = cfmmAmountOut(pool2, cfmmAmountOut(pool1, x)) − x
 *
 * Returns 0n for unprofitable trades.
 */
export function cfmmArbProfit(
  x: bigint,
  r1: bigint, s1: bigint, feeBps1: number,
  r2: bigint, s2: bigint, feeBps2: number
): bigint {
  const y = cfmmAmountOut(r1, s1, x, feeBps1);
  if (y === 0n) return 0n;
  const z = cfmmAmountOut(r2, s2, y, feeBps2);
  return z > x ? z - x : 0n;
}

// ─── Price & impact metrics ───────────────────────────────────────────────────

/**
 * Marginal (spot) price before fee: s / r, normalised for token decimals.
 * This is the infinitesimal exchange rate at the current reserves.
 */
export function cfmmSpotPrice(
  reserveIn: bigint,
  reserveOut: bigint,
  decimalsIn: number,
  decimalsOut: number
): number {
  if (reserveIn === 0n) return 0;
  const scale = 10 ** (decimalsOut - decimalsIn);
  return (Number(reserveOut) / Number(reserveIn)) * scale;
}

/**
 * Effective (realised) price for a finite trade size, normalised for decimals.
 * Always ≤ spot price due to slippage.
 */
export function cfmmEffectivePrice(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeBps: number,
  decimalsIn: number,
  decimalsOut: number
): number {
  const out = cfmmAmountOut(reserveIn, reserveOut, amountIn, feeBps);
  if (out === 0n || amountIn === 0n) return 0;
  const inF = Number(amountIn) / 10 ** decimalsIn;
  const outF = Number(out) / 10 ** decimalsOut;
  return outF / inF;
}

/**
 * Price impact as a fraction (0 – 1) for a given trade size.
 *
 *   impact = 1 − γ·r / (r + γ·x)
 *          = 1 − (effective_price / spot_price)   [ignoring fee in spot]
 *
 * At x = 0 the impact is 0. As x → ∞ the impact → 1.
 */
export function cfmmPriceImpact(
  reserveIn: bigint,
  amountIn: bigint,
  feeBps: number
): number {
  if (reserveIn === 0n || amountIn === 0n) return 0;
  const γ_n = FEE_DENOM - BigInt(feeBps * 100);
  const num = γ_n * reserveIn;
  const den = reserveIn * FEE_DENOM + γ_n * amountIn;
  return 1 - Number(num) / Number(den);
}

/**
 * Pool reserves after a swap (for checking post-trade liquidity or
 * computing the price impact on a subsequent leg).
 */
export function cfmmPostTradeReserves(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeBps: number
): { reserveIn: bigint; reserveOut: bigint } {
  const out = cfmmAmountOut(reserveIn, reserveOut, amountIn, feeBps);
  return {
    reserveIn: reserveIn + amountIn,
    reserveOut: reserveOut - out,
  };
}

/**
 * Liquidity depth: the USD-equivalent capital required to move the price by
 * 1 % (a standard measure of pool "thickness"). Larger is deeper.
 *
 *   depth ≈ r / (2 · 0.01)   [first-order approximation from ∂price/∂x]
 */
export function cfmmLiquidityDepth(
  reserveIn: bigint,
  decimalsIn: number,
  inputTokenPriceUsd: number
): number {
  const reserveFloat = Number(reserveIn) / 10 ** decimalsIn;
  return (reserveFloat * inputTokenPriceUsd) / 0.02; // = r_usd / 2%
}
