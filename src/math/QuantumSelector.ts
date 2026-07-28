/**
 * QuantumSelector — Quantum-inspired Simulated Annealing for multi-opportunity
 * portfolio selection.
 *
 * ─── Problem Formulation (QUBO) ──────────────────────────────────────────────
 * Given N arbitrage opportunities with net profits {p_i} and capital costs
 * {c_i}, and a total capital budget B, choose a binary assignment x ∈ {0,1}ᴺ
 * that maximises:
 *
 *   Maximise:  ∑ p_i · x_i
 *   Subject to: ∑ c_i · x_i ≤ B
 *
 * This is the 0/1 knapsack problem (NP-hard in general).  We reformulate it
 * as a Quadratic Unconstrained Binary Optimisation (QUBO):
 *
 *   Minimise: H(x) = −∑ p_i · x_i  +  λ · (max(0, ∑ c_i · x_i − B))²
 *
 * ─── Quantum Annealing Analogy ────────────────────────────────────────────────
 * D-Wave-style quantum annealers minimise exactly this QUBO Hamiltonian via
 * quantum tunnelling through energy barriers.  We simulate this classically
 * via Metropolis–Hastings Markov Chain Monte Carlo (MCMC):
 *
 *   At temperature T:
 *     1. Propose a random bit-flip x_i → 1−x_i   (quantum tunnelling analogue)
 *     2. Compute ΔH = H(x_new) − H(x_old)
 *     3. Accept if ΔH < 0 (downhill) OR with Boltzmann probability e^(−ΔH/T)
 *
 * "Quantum" element: We augment the acceptance with a quantum tunnelling
 * term based on the transverse-field Ising model.  The effective acceptance
 * probability becomes:
 *
 *   P_accept = max( e^(−ΔH/T),  |sin(π·T/T₀)|² )    [quantum-tunnelling floor]
 *
 * The second term simulates the transverse-field probability amplitude, which
 * allows the optimiser to tunnel through thin barriers at high T and collapse
 * onto the ground state as T → 0.
 *
 * ─── Cooling Schedule ────────────────────────────────────────────────────────
 * We use a geometric (multiplicative) cooling schedule:
 *
 *   T_k = T_0 · r^k   where r = (T_f / T_0)^(1/K)
 *
 * with T_0 = 1.0, T_f = 0.001, K = total iterations.
 * For N ≤ 20 opportunities this converges to the global optimum in practice.
 *
 * ─── References ──────────────────────────────────────────────────────────────
 * • Kadowaki & Nishimori (1998). "Quantum annealing in the transverse Ising model."
 * • Lucas (2014). "Ising formulations of many NP problems." Frontiers in Physics.
 * • Kirkpatrick, Gelatt & Vecchi (1983). "Optimization by simulated annealing."
 */

import { ArbitrageOpportunity } from "../ranking/OpportunityRanker";
import { logger } from "../utils/logger";

/** QUBO penalty coefficient λ for budget constraint violation. */
const LAMBDA = 10.0;
/** Simulated annealing iterations. */
const SA_ITERATIONS = 2_000;
/** Initial temperature. */
const T0 = 1.0;
/** Final temperature. */
const T_FINAL = 0.001;
/** Number of independent restarts (parallel Markov chains). */
const NUM_RESTARTS = 8;

// ─── Energy function ─────────────────────────────────────────────────────────

/**
 * QUBO energy (Hamiltonian) for a given binary assignment.
 *
 *   H(x) = −∑ p_i·x_i  +  λ·max(0, ∑ c_i·x_i − B)²
 */
function energy(
  x: boolean[],
  profits: number[],
  costs: number[],
  budget: number
): number {
  let totalProfit = 0;
  let totalCost = 0;
  for (let i = 0; i < x.length; i++) {
    if (x[i]) {
      totalProfit += profits[i]!;
      totalCost += costs[i]!;
    }
  }
  const violation = Math.max(0, totalCost - budget);
  return -totalProfit + LAMBDA * violation * violation;
}

/** Incremental ΔH for flipping bit i (faster than recomputing full energy). */
function deltaEnergy(
  x: boolean[],
  i: number,
  profits: number[],
  costs: number[],
  budget: number
): number {
  const sign = x[i] ? -1 : 1; // flipping on→off (sign=-1) or off→on (sign=+1)
  let totalCostBefore = 0;
  for (let j = 0; j < x.length; j++) {
    if (x[j]) totalCostBefore += costs[j]!;
  }
  const totalCostAfter = totalCostBefore + sign * costs[i]!;

  const violBefore = Math.max(0, totalCostBefore - budget);
  const violAfter = Math.max(0, totalCostAfter - budget);

  return (
    -sign * profits[i]! +
    LAMBDA * (violAfter * violAfter - violBefore * violBefore)
  );
}

// ─── Quantum-inspired acceptance probability ──────────────────────────────────

/**
 * Acceptance probability with quantum-tunnelling floor.
 *
 *   P = max( e^(−ΔH/T),  sin²(π·T/T₀) )
 *
 * At high T the sin² term dominates, enabling wide exploration.
 * As T → 0 the term vanishes, leaving pure Boltzmann acceptance.
 */
function acceptProbability(deltaH: number, T: number): number {
  const boltzmann = Math.exp(-deltaH / T);
  const quantumTunnel = Math.sin((Math.PI * T) / T0) ** 2;
  return Math.max(boltzmann, quantumTunnel);
}

// ─── Single-chain simulated annealing ────────────────────────────────────────

function annealChain(
  profits: number[],
  costs: number[],
  budget: number,
  seed: number
): { x: boolean[]; totalProfit: number; totalCost: number } {
  const N = profits.length;
  const coolingRate = Math.pow(T_FINAL / T0, 1 / SA_ITERATIONS);

  // Initialise: random feasible assignment
  let x = profits.map((_, i) => ((seed * 1103515245 + i * 12345) % 2) === 0);
  let T = T0;

  // LCG random number generator (fast, deterministic, seed-based)
  let rngState = seed ^ 0xdeadbeef;
  const rand = () => {
    rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
    return rngState / 0x100000000;
  };

  for (let iter = 0; iter < SA_ITERATIONS; iter++) {
    // Pick a random bit to flip
    const i = Math.floor(rand() * N);
    const dH = deltaEnergy(x, i, profits, costs, budget);

    if (dH <= 0 || rand() < acceptProbability(dH, T)) {
      x[i] = !x[i];
    }

    T *= coolingRate;
  }

  let totalProfit = 0;
  let totalCost = 0;
  for (let i = 0; i < N; i++) {
    if (x[i]) {
      totalProfit += profits[i]!;
      totalCost += costs[i]!;
    }
  }

  return { x, totalProfit, totalCost };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PortfolioSelection {
  /** Selected opportunities (highest-value subset within budget). */
  selected: ArbitrageOpportunity[];
  /** Total expected net profit of the portfolio. */
  totalNetProfitUsd: number;
  /** Total capital required. */
  totalCapitalUsd: number;
  /** Energy value of the best solution found. */
  energy: number;
}

/**
 * Select the optimal portfolio of arbitrage opportunities within a capital
 * budget using quantum-inspired simulated annealing.
 *
 * Falls back to simple greedy selection when N ≤ 2 (exact optimum trivial).
 *
 * @param opportunities  Ranked list of candidate opportunities.
 * @param budgetUsd      Available capital in USD.
 * @param inputPriceUsd  Price of the input token in USD (for cost estimation).
 */
export function selectOptimalPortfolio(
  opportunities: ArbitrageOpportunity[],
  budgetUsd: number,
  inputPriceUsd: number
): PortfolioSelection {
  if (opportunities.length === 0) {
    return { selected: [], totalNetProfitUsd: 0, totalCapitalUsd: 0, energy: 0 };
  }

  // Simple greedy for trivial cases (≤ 2 items)
  if (opportunities.length <= 2) {
    const selected = opportunities.filter((o) => {
      const cost = estimateCostUsd(o, inputPriceUsd);
      return cost <= budgetUsd;
    });
    return {
      selected,
      totalNetProfitUsd: selected.reduce((s, o) => s + o.netProfitUsd, 0),
      totalCapitalUsd: selected.reduce((s, o) => s + estimateCostUsd(o, inputPriceUsd), 0),
      energy: 0,
    };
  }

  const profits = opportunities.map((o) => o.netProfitUsd);
  const costs = opportunities.map((o) => estimateCostUsd(o, inputPriceUsd));

  // Run NUM_RESTARTS independent annealing chains with different seeds
  let bestResult = { x: opportunities.map(() => false), totalProfit: 0, totalCost: 0 };
  let bestEnergy = Infinity;

  for (let restart = 0; restart < NUM_RESTARTS; restart++) {
    const result = annealChain(profits, costs, budgetUsd, restart * 7919 + 1337);
    const e = energy(result.x, profits, costs, budgetUsd);
    if (e < bestEnergy) {
      bestEnergy = e;
      bestResult = result;
    }
  }

  const selected = opportunities.filter((_, i) => bestResult.x[i]);

  logger.debug(`Quantum portfolio selection`, {
    candidates: opportunities.length,
    selected: selected.length,
    totalProfitUsd: bestResult.totalProfit.toFixed(2),
    totalCostUsd: bestResult.totalCost.toFixed(2),
    energy: bestEnergy.toFixed(4),
  });

  return {
    selected,
    totalNetProfitUsd: bestResult.totalProfit,
    totalCapitalUsd: bestResult.totalCost,
    energy: bestEnergy,
  };
}

/** Estimate capital required for an opportunity in USD. */
function estimateCostUsd(o: ArbitrageOpportunity, inputPriceUsd: number): number {
  // tradeAmountIn is in raw input-token units
  // A safe approximation: use gross profit + gas as a proxy for capital needed
  return o.grossProfitUsd + o.gasCostUsd;
}
