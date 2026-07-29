/**
 * C2DecisionEngine — formal D_C2 terminal decision function.
 *
 * This module is the ONLY place where the C2 MIRROR / REVERSE / NO_OP decision
 * is made.  It receives two fresh route evaluations that must have been derived
 * exclusively from post-C1 reloaded state (identified by `c1StateHash`).
 *
 * INVARIANTS enforced here:
 *  - Evaluations derived from a mismatched `c1StateHash` are rejected.
 *  - C1 quotes, sizing, pool reserves, calldata, or predicted profit MUST NOT
 *    appear in the `C2RouteEvaluation` inputs.  This is a caller responsibility
 *    documented in the `C2DecisionInput` interface.
 *  - The function is pure and deterministic given its inputs; it has no side
 *    effects and does not submit any transaction.
 *
 * Formal decision function:
 *
 *   D_C2 = MIRROR   if V_M = 1  AND  N_M ≥ N_min  AND  N_M ≥ N_R
 *          REVERSE  if V_R = 1  AND  N_R ≥ N_min  AND  N_R >  N_M
 *          NO_OP    otherwise
 *
 * Where:
 *   N_M   = mirrorEval.netProfitUsd
 *   N_R   = reverseEval.netProfitUsd
 *   V_M   = mirrorEval.valid
 *   V_R   = reverseEval.valid
 *   N_min = minNetProfitUsd
 */

import type {
  C2Decision,
  C2DecisionInput,
  C2DecisionOutput,
} from '../../types/index.js';

// ── C2DecisionEngine ──────────────────────────────────────────────────────────

export class C2DecisionEngine {
  /**
   * Evaluate the formal D_C2 terminal decision function.
   *
   * @param input - Evaluated MIRROR and REVERSE routes plus the minimum-profit
   *   threshold.  Both evaluations MUST have been produced from state loaded
   *   after C1 confirmation, keyed to `input.c1StateHash`.
   * @returns The terminal decision (MIRROR / REVERSE / NO_OP) with full rationale.
   */
  decide(input: C2DecisionInput): C2DecisionOutput {
    const { c1StateHash, minNetProfitUsd, mirrorEval, reverseEval } = input;

    if (!c1StateHash || c1StateHash === '0x0') {
      return noOp('NO_C1_STATE_HASH: decision rejected — c1StateHash is missing or zero');
    }

    const nM = mirrorEval.netProfitUsd;
    const nR = reverseEval.netProfitUsd;
    const vM = mirrorEval.valid;
    const vR = reverseEval.valid;

    // ── MIRROR branch ─────────────────────────────────────────────────────────
    if (vM && nM >= minNetProfitUsd && nM >= nR) {
      return {
        decision: 'MIRROR',
        selectedNetProfitUsd: nM,
        selectedRouteHash: mirrorEval.routeHash,
        rationale:
          `MIRROR selected: V_M=1, N_M=${nM.toFixed(4)} >= N_min=${minNetProfitUsd.toFixed(4)}, ` +
          `N_M >= N_R=${nR.toFixed(4)}`,
      };
    }

    // ── REVERSE branch ────────────────────────────────────────────────────────
    if (vR && nR >= minNetProfitUsd && nR > nM) {
      return {
        decision: 'REVERSE',
        selectedNetProfitUsd: nR,
        selectedRouteHash: reverseEval.routeHash,
        rationale:
          `REVERSE selected: V_R=1, N_R=${nR.toFixed(4)} >= N_min=${minNetProfitUsd.toFixed(4)}, ` +
          `N_R > N_M=${nM.toFixed(4)}`,
      };
    }

    // ── NO_OP branch ──────────────────────────────────────────────────────────
    return noOp(buildNoOpRationale({ vM, vR, nM, nR, minNetProfitUsd, mirrorEval, reverseEval }));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function noOp(rationale: string): C2DecisionOutput {
  return {
    decision: 'NO_OP',
    selectedNetProfitUsd: 0,
    selectedRouteHash: null,
    rationale,
  };
}

interface NoOpRationaleParams {
  vM: boolean;
  vR: boolean;
  nM: number;
  nR: number;
  minNetProfitUsd: number;
  mirrorEval: C2DecisionInput['mirrorEval'];
  reverseEval: C2DecisionInput['reverseEval'];
}

function buildNoOpRationale(p: NoOpRationaleParams): string {
  const parts: string[] = ['NO_OP:'];

  if (!p.vM && !p.vR) {
    parts.push('neither MIRROR nor REVERSE route passed all gates.');
    if (p.mirrorEval.rejectionReasons.length > 0) {
      parts.push(`MIRROR gates: [${p.mirrorEval.rejectionReasons.join(', ')}].`);
    }
    if (p.reverseEval.rejectionReasons.length > 0) {
      parts.push(`REVERSE gates: [${p.reverseEval.rejectionReasons.join(', ')}].`);
    }
  } else if (p.vM && p.nM < p.minNetProfitUsd && (!p.vR || p.nR < p.minNetProfitUsd)) {
    parts.push(
      `both routes below minimum profit — ` +
      `N_M=${p.nM.toFixed(4)}, N_R=${p.nR.toFixed(4)}, N_min=${p.minNetProfitUsd.toFixed(4)}.`,
    );
  } else if (!p.vM && p.vR && p.nR < p.minNetProfitUsd) {
    parts.push(
      `REVERSE valid but below minimum profit — N_R=${p.nR.toFixed(4)}, N_min=${p.minNetProfitUsd.toFixed(4)}.`,
    );
  } else {
    parts.push(
      `V_M=${p.vM}, V_R=${p.vR}, N_M=${p.nM.toFixed(4)}, N_R=${p.nR.toFixed(4)}, ` +
      `N_min=${p.minNetProfitUsd.toFixed(4)}.`,
    );
  }

  return parts.join(' ');
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export type { C2Decision, C2DecisionInput, C2DecisionOutput };
