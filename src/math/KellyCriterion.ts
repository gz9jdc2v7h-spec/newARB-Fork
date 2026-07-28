/**
 * KellyCriterion — Optimal position sizing for repeated bets.
 *
 * ─── Classic Kelly Criterion ──────────────────────────────────────────────────
 * For a bet with:
 *   p = probability of winning
 *   q = 1 − p = probability of losing
 *   b = net profit per unit wagered on a win  (e.g. b = 2 means triple money)
 *
 * The Kelly fraction that maximises the expected logarithm of wealth
 * (geometric mean growth) is:
 *
 *   f* = (b·p − q) / b  =  p − q/b
 *
 * Derivation via calculus:
 *   Let W_n = bankroll after n bets.  E[ln(W_{n+1}/W_n)] = p·ln(1+f·b) + q·ln(1−f)
 *   Setting d/df = 0:   p·b/(1+f·b) − q/(1−f) = 0
 *   Solving for f gives the formula above.
 *
 * ─── DeFi Arbitrage Adaptation ───────────────────────────────────────────────
 * For an arb opportunity:
 *   b_win  = netProfitUsd / capitalRequiredUsd   (net return if successful)
 *   b_lose = gasCostUsd / capitalRequiredUsd      (cost if tx reverts)
 *   p      = estimated execution success probability
 *
 * Modified Kelly for asymmetric win/loss:
 *   f* = (b_win · p − b_lose · q) / (b_win + b_lose)
 *
 * ─── Risk Management ──────────────────────────────────────────────────────────
 * Full Kelly is theoretically optimal but leads to extreme volatility.
 * Fractional Kelly (0.25f* to 0.5f*) provides a more conservative approach,
 * reducing variance quadratically while sacrificing only a linear fraction of
 * long-run growth.
 *
 * Kelly fraction bound: capped at MAX_KELLY_FRACTION to limit single-bet risk.
 */

/** Maximum fraction of bankroll risked on any single opportunity. */
export const MAX_KELLY_FRACTION = 0.25;

/** Default assumed execution success rate for on-chain arb (historical base rate). */
export const DEFAULT_WIN_RATE = 0.88;

// ─── Core formulae ────────────────────────────────────────────────────────────

/**
 * Classic Kelly fraction for a binary outcome bet.
 *
 * @param p   Probability of success (0–1).
 * @param b   Net profit per unit wagered on success (>0).
 * @returns   Optimal fraction of bankroll to wager (0–1), clamped to [0, 1].
 */
export function kellyFraction(p: number, b: number): number {
  if (b <= 0 || p <= 0) return 0;
  const q = 1 - p;
  const f = (b * p - q) / b; // = p - q/b
  return Math.max(0, Math.min(1, f));
}

/**
 * Fractional Kelly — Kelly × fraction.
 * A fraction of 0.5 ("half-Kelly") halves the growth rate sacrifice but
 * dramatically reduces variance (σ² ∝ f², E[growth] ∝ f − f²/2).
 *
 * @param fraction  Fraction of full Kelly to apply (0–1, default 0.5).
 * @param p         Probability of success.
 * @param b         Net profit per unit wagered on success.
 */
export function fractionalKelly(fraction: number, p: number, b: number): number {
  return Math.min(fraction * kellyFraction(p, b), MAX_KELLY_FRACTION);
}

/**
 * Optimal position size in USD for a DeFi arbitrage opportunity.
 *
 * Uses a modified Kelly formula that accounts for asymmetric outcomes:
 *   - Win: receive netProfitUsd
 *   - Lose: spend gasCostUsd (reverted transaction)
 *
 * Modified formula (derived by maximising E[ln(W)] for asymmetric b):
 *
 *   f* = (b_win · p  −  b_lose · q) / (b_win + b_lose)
 *
 * where b_win = netProfitUsd/capital, b_lose = gasCostUsd/capital.
 *
 * @param netProfitUsd   Expected net profit if execution succeeds.
 * @param gasCostUsd     Gas cost (lost if tx reverts).
 * @param capitalUsd     Capital required for the trade (input amount in USD).
 * @param bankrollUsd    Total available capital.
 * @param winRate        Estimated success probability (default 0.88).
 * @param kellyScale     Fraction of Kelly to use (default 0.5 = half-Kelly).
 * @returns Recommended position size in USD.
 */
export function kellyPositionSize(
  netProfitUsd: number,
  gasCostUsd: number,
  capitalUsd: number,
  bankrollUsd: number,
  winRate = DEFAULT_WIN_RATE,
  kellyScale = 0.5
): number {
  if (capitalUsd <= 0 || bankrollUsd <= 0) return 0;

  const q = 1 - winRate;
  const bWin = netProfitUsd / capitalUsd;
  const bLose = gasCostUsd / capitalUsd;

  // Modified Kelly for asymmetric outcomes
  const fStar = (bWin * winRate - bLose * q) / (bWin + bLose);
  const fCapped = Math.max(0, Math.min(MAX_KELLY_FRACTION, fStar * kellyScale));

  return bankrollUsd * fCapped;
}

/**
 * Expected logarithmic utility (growth rate) of a Kelly bet at fraction f.
 *
 *   G(f) = p · ln(1 + f · b_win) + q · ln(1 − f · b_lose)
 *
 * Useful for comparing strategies and verifying Kelly optimality.
 */
export function kellyGrowthRate(
  f: number,
  netProfitUsd: number,
  gasCostUsd: number,
  capitalUsd: number,
  winRate = DEFAULT_WIN_RATE
): number {
  if (capitalUsd <= 0 || f <= 0) return 0;
  const q = 1 - winRate;
  const bWin = netProfitUsd / capitalUsd;
  const bLose = gasCostUsd / capitalUsd;
  const winTerm = Math.log(1 + f * bWin);
  const loseTerm = Math.log(1 - f * bLose);
  if (!isFinite(loseTerm)) return -Infinity;
  return winRate * winTerm + q * loseTerm;
}

/**
 * Kelly-based risk-adjusted score for ranking opportunities.
 *
 * Combines expected growth rate and Sharpe-like risk scaling:
 *
 *   score = G(f*) × (1 / volatilityFactor)
 *
 * Higher score = better risk-adjusted return.
 */
export function kellyScore(
  netProfitUsd: number,
  gasCostUsd: number,
  capitalUsd: number,
  winRate = DEFAULT_WIN_RATE,
  volatilityFactor = 1
): number {
  if (capitalUsd <= 0 || volatilityFactor <= 0) return 0;
  const bWin = netProfitUsd / capitalUsd;
  const bLose = gasCostUsd / capitalUsd;
  const fStar = Math.max(
    0,
    Math.min(MAX_KELLY_FRACTION, (bWin * winRate - bLose * (1 - winRate)) / (bWin + bLose))
  );
  const g = kellyGrowthRate(fStar, netProfitUsd, gasCostUsd, capitalUsd, winRate);
  return Math.max(0, g / volatilityFactor);
}
