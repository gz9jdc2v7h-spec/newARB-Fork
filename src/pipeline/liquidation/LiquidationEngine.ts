import type { ConfigRecord, StateRecord } from '../../types/index.js';
import { AuditLogger } from '../transparency/AuditLogger.js';

export type LiquidationDecision = 'EXECUTE' | 'NO_OP';

export interface LiquidationExecutionRequest {
  opportunityId: string;
  cycleId: string;
  config: ConfigRecord;
  postTriggerState: StateRecord;
  reloadedStateHash: string;
  healthFactor: string;
  maxHealthFactorToLiquidate: string;
  simulationPassed: boolean;
  maxStateAgeBlocks: number;
}

export interface LiquidationExecutionResult {
  cycleId: string;
  decision: LiquidationDecision;
  skipped: boolean;
  reason?: string;
}

/**
 * Liquidation lane scaffold.
 * Independent lane with explicit state reload + gate lifecycle.
 */
export class LiquidationEngine {
  private readonly logger: AuditLogger;

  constructor(logger?: AuditLogger) {
    this.logger = logger ?? new AuditLogger();
  }

  async execute(req: LiquidationExecutionRequest): Promise<LiquidationExecutionResult> {
    if (req.postTriggerState.stateHash !== req.reloadedStateHash) {
      this.logger.logRejection({
        opportunityId: req.opportunityId,
        stage: 'SUBMISSION',
        status: 'REJECTED',
        reason: 'STATE_TOO_OLD',
        configVersion: req.config.configVersion,
        stateHash: req.postTriggerState.stateHash,
        detail: 'Liquidation lane state reload mismatch',
        timestamp: Date.now(),
      });
      return {
        cycleId: req.cycleId,
        decision: 'NO_OP',
        skipped: true,
        reason: 'STATE_RELOAD_MISMATCH',
      };
    }

    if (req.postTriggerState.stateAgeBlocks > req.maxStateAgeBlocks) {
      return {
        cycleId: req.cycleId,
        decision: 'NO_OP',
        skipped: true,
        reason: 'STATE_TOO_OLD',
      };
    }

    if (!req.simulationPassed) {
      return {
        cycleId: req.cycleId,
        decision: 'NO_OP',
        skipped: true,
        reason: 'SIMULATION_FAILED',
      };
    }

    if (Number(req.healthFactor) > Number(req.maxHealthFactorToLiquidate)) {
      return {
        cycleId: req.cycleId,
        decision: 'NO_OP',
        skipped: true,
        reason: 'HEALTH_FACTOR_SAFE',
      };
    }

    return {
      cycleId: req.cycleId,
      decision: 'EXECUTE',
      skipped: false,
    };
  }
}
