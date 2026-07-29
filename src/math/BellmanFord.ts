/**
 * BellmanFord — Multi-hop arbitrage path discovery.
 *
 * ─── Mathematical formulation ────────────────────────────────────────────────
 * Represent the DEX price universe as a directed weighted graph G = (V, E):
 *
 *   V = { distinct token symbols }
 *   E = { (tokenIn, tokenOut, w) | w = −ln(price) for each DEX quote }
 *
 * A profitable arbitrage cycle satisfies:
 *
 *   ∑ w_i < 0   over the cycle edges
 *   ⟺   ∑ −ln(price_i) < 0
 *   ⟺   ∏ price_i > 1   (product of exchange rates exceeds 1)
 *
 * Bellman–Ford detects negative-weight cycles in O(|V| · |E|) time.
 *
 * ─── Algorithm ────────────────────────────────────────────────────────────────
 * 1. Initialise dist[source] = 0, dist[v] = +∞ for v ≠ source.
 * 2. Relax all edges |V|−1 times:
 *      if dist[u] + w(u,v) < dist[v]  then  dist[v] ← dist[u] + w(u,v)
 * 3. If any edge can still be relaxed in round |V|, a negative cycle exists.
 * 4. Trace predecessor pointers to reconstruct the cycle.
 *
 * Complexity: O(|V| · |E|) = O(tokens · dex_quotes)
 *   In practice: ~10 tokens, ~50 quotes  ⟹  ~500 operations per scan.
 */

import { PairQuotes } from "../discovery/OpportunityScanner";
import { logger } from "../utils/logger";

export interface ArbPath {
  /** Ordered token symbols forming the cycle, e.g. ["WETH","USDC","ARB","WETH"] */
  tokens: string[];
  /** DEX used for each hop */
  dexes: string[];
  /** Exchange rate for each hop (amountOut / amountIn, normalised) */
  prices: number[];
  /** ∏ prices_i — exceeds 1 for profitable cycles */
  priceProduct: number;
  /** Gross profit factor: priceProduct − 1  (e.g. 0.003 = 0.3 %) */
  grossFactor: number;
}

// ─── Internal graph types ─────────────────────────────────────────────────────

interface Edge {
  from: string;
  to: string;
  dex: string;
  logWeight: number; // −ln(price)
  price: number;
}

interface PredEntry {
  fromNode: string;
  dex: string;
  price: number;
}

// ─── Graph construction ───────────────────────────────────────────────────────

function buildEdges(snapshot: PairQuotes[]): Edge[] {
  const edges: Edge[] = [];
  for (const pair of snapshot) {
    for (const quote of pair.quotes) {
      if (quote.price <= 0) continue;
      edges.push({
        from: pair.tokenIn,
        to: pair.tokenOut,
        dex: quote.dex,
        logWeight: -Math.log(quote.price),
        price: quote.price,
      });
    }
  }
  return edges;
}

// ─── Cycle tracing ────────────────────────────────────────────────────────────

/**
 * Reconstruct an arbitrage cycle from Bellman–Ford predecessor pointers.
 *
 * Strategy:
 *   1. Starting from the node detected to be on a negative cycle, advance
 *      |V| steps along predecessor pointers — this guarantees we land inside
 *      the cycle (not on a tail leading into it).
 *   2. From that node, trace predecessor pointers until we revisit it, thereby
 *      collecting the exact cycle.
 *   3. Reverse the path (predecessor pointers are backward edges) and close
 *      the cycle by appending the start node.
 *
 * Time: O(|V|).
 */
function traceCycle(
  detectedNode: string,
  pred: Map<string, PredEntry>,
  V: number
): { tokens: string[]; dexes: string[]; prices: number[] } | null {
  // Step 1: advance V steps to land inside the cycle
  let current = detectedNode;
  for (let i = 0; i < V; i++) {
    const p = pred.get(current);
    if (!p) return null;
    current = p.fromNode;
  }

  // Step 2: trace the cycle
  const cycleStart = current;
  const revTokens: string[] = [current];
  const revDexes: string[] = [];
  const revPrices: number[] = [];

  let node = current;
  for (let i = 0; i < V + 1; i++) {
    const p = pred.get(node);
    if (!p) return null;
    revDexes.push(p.dex);
    revPrices.push(p.price);
    node = p.fromNode;
    revTokens.push(node);
    if (node === cycleStart) {
      // Step 3: reverse to get forward trading direction
      revTokens.reverse();
      revDexes.reverse();
      revPrices.reverse();
      return { tokens: revTokens, dexes: revDexes, prices: revPrices };
    }
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Find all profitable multi-hop arbitrage cycles in the current price snapshot.
 *
 * Runs Bellman–Ford from every source node and collects negative cycles.
 * Deduplicates cycles by their sorted token-set fingerprint.
 *
 * @param snapshot  Price snapshot from OpportunityScanner.
 * @param maxHops   Maximum cycle length to search for (default 4).
 * @returns Profitable arb paths sorted by grossFactor descending.
 */
export function findArbitragePaths(
  snapshot: PairQuotes[],
  maxHops = 4
): ArbPath[] {
  const edges = buildEdges(snapshot);
  if (edges.length === 0) return [];

  const nodeSet = new Set<string>();
  for (const e of edges) {
    nodeSet.add(e.from);
    nodeSet.add(e.to);
  }
  const nodes = Array.from(nodeSet);
  const V = nodes.length;
  if (V < 2) return [];

  const results: ArbPath[] = [];
  const seenCycles = new Set<string>();
  const relaxIters = Math.min(V - 1, maxHops);

  for (const source of nodes) {
    const dist = new Map<string, number>(nodes.map((n) => [n, Infinity]));
    const pred = new Map<string, PredEntry>();
    dist.set(source, 0);

    // Bellman–Ford: relax edges relaxIters times
    for (let iter = 0; iter < relaxIters; iter++) {
      for (const edge of edges) {
        const d = dist.get(edge.from);
        if (d === undefined || !isFinite(d)) continue;
        const newDist = d + edge.logWeight;
        if (newDist < (dist.get(edge.to) ?? Infinity)) {
          dist.set(edge.to, newDist);
          pred.set(edge.to, { fromNode: edge.from, dex: edge.dex, price: edge.price });
        }
      }
    }

    // Detect further-relaxable edges → negative cycle
    for (const edge of edges) {
      const d = dist.get(edge.from);
      if (d === undefined || !isFinite(d)) continue;
      if (d + edge.logWeight < (dist.get(edge.to) ?? Infinity)) {
        const cycle = traceCycle(edge.to, pred, V);
        if (!cycle) continue;

        // Deduplication key: sorted token set
        const key = [...cycle.tokens].sort().join("|");
        if (seenCycles.has(key)) continue;
        seenCycles.add(key);

        // Compute price product (must be > 1 for profitable cycle)
        const priceProduct = cycle.prices.reduce((p, r) => p * r, 1);
        if (priceProduct <= 1) continue;

        results.push({
          tokens: cycle.tokens,
          dexes: cycle.dexes,
          prices: cycle.prices,
          priceProduct,
          grossFactor: priceProduct - 1,
        });
      }
    }
  }

  results.sort((a, b) => b.grossFactor - a.grossFactor);

  if (results.length > 0) {
    logger.debug(`Bellman-Ford: ${results.length} arb cycle(s)`, {
      best: results[0]!.tokens.join("→"),
      grossFactor: (results[0]!.grossFactor * 100).toFixed(3) + "%",
    });
  }

  return results;
}

/**
 * Returns the canonicalised key for a cycle (token set, order-independent).
 * Useful for correlating Bellman-Ford paths with two-pool opportunities.
 */
export function cycleKey(tokens: string[]): string {
  return [...new Set(tokens)].sort().join("|");
}
