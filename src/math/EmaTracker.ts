/**
 * EmaTracker — Exponential Moving Average, volatility, and momentum tracking.
 *
 * ─── Exponential Moving Average ───────────────────────────────────────────────
 * EMA is defined by the recurrence:
 *
 *   EMA_t = α · x_t + (1 − α) · EMA_{t−1}
 *
 * Smoothing factor:  α = 2 / (N + 1)   (N-period EMA)
 *
 * This gives recent observations exponentially more weight, with a half-life of
 *
 *   t_{1/2} = −ln(2) / ln(1−α) ≈ (N−1) · ln(2)  blocks.
 *
 * ─── Volatility Estimation ────────────────────────────────────────────────────
 * We use an EMA of squared log-returns (RMS volatility):
 *
 *   r_t = ln(x_t / x_{t−1})          (log return)
 *   σ²_t = α · r_t² + (1−α) · σ²_{t−1}   (EMA of squared returns)
 *   σ_t = √σ²_t                       (annualised if needed)
 *
 * For very fast intra-block tracking, we keep both a short-window and a
 * long-window variance and flag regime changes (volatility spikes).
 *
 * ─── Momentum Signal ──────────────────────────────────────────────────────────
 * Dual-EMA momentum (DEMA crossover):
 *
 *   momentum_t = EMA_short / EMA_long − 1
 *
 * Positive momentum suggests upward price trend; during strong momentum,
 * arbitrage spreads tend to be wider and more persistent.
 *
 * ─── Bollinger Band–style spread filter ──────────────────────────────────────
 * Dynamic spread threshold:
 *
 *   threshold(t) = μ_spread + k · σ_spread
 *
 * Only take opportunities where the observed spread exceeds this threshold,
 * reducing false positives during high-noise periods.
 */

/** Default short EMA window (blocks) for momentum tracking. */
const SHORT_WINDOW = 5;
/** Default long EMA window (blocks) for trend tracking. */
const LONG_WINDOW = 20;
/** Bollinger-band sigma multiplier for spread threshold. */
const BB_SIGMA = 2.0;

function alpha(window: number): number {
  return 2 / (window + 1);
}

// ─── Per-pair price tracker ───────────────────────────────────────────────────

export interface PriceStats {
  emaShort: number;
  emaLong: number;
  variance: number;
  /** Annualised daily volatility estimate (σ per day, assuming 4-s blocks → 21600 blocks/day) */
  dailyVolatility: number;
  /** Momentum: EMA_short/EMA_long − 1. Positive = trending up. */
  momentum: number;
  /** Minimum spread required (Bollinger threshold). */
  spreadThreshold: number;
  sampleCount: number;
}

export class PairTracker {
  private readonly shortAlpha: number;
  private readonly longAlpha: number;
  private readonly varAlpha: number;
  private readonly spreadAlpha: number;

  private emaShort: number | null = null;
  private emaLong: number | null = null;
  private variance = 0;
  private spreadEma = 0;
  private spreadVar = 0;
  private prevPrice: number | null = null;
  private sampleCount = 0;

  constructor(
    shortWindow = SHORT_WINDOW,
    longWindow = LONG_WINDOW
  ) {
    this.shortAlpha = alpha(shortWindow);
    this.longAlpha = alpha(longWindow);
    this.varAlpha = alpha(longWindow); // volatility tracks at long-window speed
    this.spreadAlpha = alpha(longWindow);
  }

  /** Feed a new price observation (typically the mid-price across DEXes). */
  update(price: number): void {
    if (price <= 0 || !isFinite(price)) return;
    this.sampleCount++;

    // Update EMAs
    if (this.emaShort === null) {
      this.emaShort = price;
      this.emaLong = price;
      this.prevPrice = price;
      return;
    }

    this.emaShort = this.shortAlpha * price + (1 - this.shortAlpha) * this.emaShort;
    this.emaLong = this.longAlpha! * price + (1 - this.longAlpha) * this.emaLong!;

    // Log-return and variance (EMA of r²)
    const logReturn = Math.log(price / this.prevPrice!);
    this.variance =
      this.varAlpha * logReturn * logReturn + (1 - this.varAlpha) * this.variance;
    this.prevPrice = price;
  }

  /** Feed a new spread observation (e.g. (sellPrice - buyPrice) / buyPrice). */
  updateSpread(spread: number): void {
    if (spread < 0 || !isFinite(spread)) return;
    // EMA of spread
    this.spreadEma = this.spreadAlpha * spread + (1 - this.spreadAlpha) * this.spreadEma;
    // EMA of (spread − spread_ema)²
    const dev = spread - this.spreadEma;
    this.spreadVar = this.spreadAlpha * dev * dev + (1 - this.spreadAlpha) * this.spreadVar;
  }

  /** Returns current price statistics. */
  getStats(): PriceStats {
    const emaShort = this.emaShort ?? 0;
    const emaLong = this.emaLong ?? 0;
    const momentum = emaLong > 0 ? emaShort / emaLong - 1 : 0;

    // Convert per-block variance to daily (4-second Arbitrum blocks → 21600/day)
    const blocksPerDay = 21_600;
    const dailyVolatility = Math.sqrt(this.variance * blocksPerDay);

    // Bollinger spread threshold: spreadEma + BB_SIGMA * sqrt(spreadVar)
    const spreadThreshold = this.spreadEma + BB_SIGMA * Math.sqrt(this.spreadVar);

    return {
      emaShort,
      emaLong,
      variance: this.variance,
      dailyVolatility,
      momentum,
      spreadThreshold: Math.max(spreadThreshold, 0),
      sampleCount: this.sampleCount,
    };
  }

  get isWarm(): boolean {
    // Consider tracker "warmed up" once we have enough samples
    return this.sampleCount >= SHORT_WINDOW;
  }
}

// ─── Multi-pair EMA registry ──────────────────────────────────────────────────

/**
 * EmaTracker — Registry of per-pair PairTracker instances.
 *
 * Call `update(pairKey, price, spread)` each scan cycle to feed fresh data,
 * then call `getStats(pairKey)` in the ranker to retrieve volatility/momentum.
 */
export class EmaTracker {
  private readonly trackers = new Map<string, PairTracker>();

  /** Feed a new observation for a token pair. */
  update(tokenIn: string, tokenOut: string, price: number, spread: number): void {
    const key = `${tokenIn}/${tokenOut}`;
    let t = this.trackers.get(key);
    if (!t) {
      t = new PairTracker();
      this.trackers.set(key, t);
    }
    t.update(price);
    t.updateSpread(spread);
  }

  /** Retrieve stats for a token pair. Returns null if no data yet. */
  getStats(tokenIn: string, tokenOut: string): PriceStats | null {
    const t = this.trackers.get(`${tokenIn}/${tokenOut}`);
    return t ? t.getStats() : null;
  }

  /** Returns the recommended spread threshold for the pair, or 0 if not warmed up. */
  spreadThreshold(tokenIn: string, tokenOut: string): number {
    const stats = this.getStats(tokenIn, tokenOut);
    if (!stats || !this.trackers.get(`${tokenIn}/${tokenOut}`)?.isWarm) return 0;
    return stats.spreadThreshold;
  }

  /**
   * Volatility-adjusted spread requirement.
   * During high-volatility regimes, require a wider spread to avoid
   * trading into adverse price moves between quote and execution.
   *
   * adjustment = max(threshold, 2 × dailyVol / √blocksPerDay × slippageFactor)
   */
  adjustedMinSpread(tokenIn: string, tokenOut: string, baseMinSpread: number): number {
    const stats = this.getStats(tokenIn, tokenOut);
    if (!stats) return baseMinSpread;
    // Intra-block vol estimate (1-block annualised slice)
    const blockVol = stats.dailyVolatility / Math.sqrt(21_600);
    const volBump = 2 * blockVol; // 2-sigma intra-block move
    return Math.max(baseMinSpread, stats.spreadThreshold, volBump);
  }
}

// ─── History window for regime detection ─────────────────────────────────────

/**
 * VolatilityRegime classifies current market conditions.
 * Used to tune aggressiveness of the arb strategy.
 */
export type VolatilityRegime = "low" | "normal" | "high" | "extreme";

export function classifyRegime(dailyVolatility: number): VolatilityRegime {
  if (dailyVolatility < 0.01) return "low";       // < 1 % daily vol
  if (dailyVolatility < 0.05) return "normal";    // 1–5 %
  if (dailyVolatility < 0.15) return "high";      // 5–15 %
  return "extreme";                                // > 15 %
}
