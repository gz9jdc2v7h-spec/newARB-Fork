import {
  ENABLE_ATOMIC_FLASH,
  ENABLE_PRIVATE_RELAY,
  QUOTE_MAX_AGE_MS,
} from "../config";

export type ExecutionMode =
  | "dry_run"
  | "sequential_live"
  | "private_relay_live"
  | "atomic_flash";

export interface ExecutionIntent {
  hasPrivateKey: boolean;
  routeKind: "two_leg" | "multi_hop";
  requiresFlashLoan: boolean;
  quoteAgeMs: number;
  supportsPrivateRelay: boolean;
  supportsAtomicFlash: boolean;
  expectedNetProfitUsd: number;
  riskFlags: string[];
}

export interface ExecutionDecision {
  mode: ExecutionMode;
  rationale: string;
  shouldExecute: boolean;
  riskFlags: string[];
}

export function decideExecutionMode(intent: ExecutionIntent): ExecutionDecision {
  const riskFlags = [...intent.riskFlags];

  if (!intent.hasPrivateKey) {
    return {
      mode: "dry_run",
      rationale: "PRIVATE_KEY not configured",
      shouldExecute: false,
      riskFlags,
    };
  }

  if (intent.quoteAgeMs > QUOTE_MAX_AGE_MS) {
    riskFlags.push("stale_quotes");
  }

  if (intent.routeKind === "multi_hop") {
    riskFlags.push("multi_hop_route");
  }

  if (
    intent.requiresFlashLoan &&
    ENABLE_ATOMIC_FLASH &&
    intent.supportsAtomicFlash
  ) {
    return {
      mode: "atomic_flash",
      rationale: "flash-backed route requested and enabled",
      shouldExecute: riskFlags.length === 0,
      riskFlags,
    };
  }

  if (ENABLE_PRIVATE_RELAY && intent.supportsPrivateRelay) {
    return {
      mode: "private_relay_live",
      rationale: "private relay execution enabled",
      shouldExecute: riskFlags.length === 0,
      riskFlags,
    };
  }

  return {
    mode: "sequential_live",
    rationale: "default live execution path",
    shouldExecute: riskFlags.length === 0,
    riskFlags,
  };
}
