/**
 * EvidenceChain — accumulates stage evidence for one opportunity and produces
 * a complete, hashable OpportunityEvidenceChain ready for ledger writing.
 *
 * Usage:
 *   const chain = new EvidenceChain(opportunityId, configVersion, configHash);
 *   chain.setConfig(configRecord);
 *   chain.setState(stateRecord);
 *   chain.setRoute(routeRecord);
 *   // ... etc
 *   const final = chain.build();
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import type {
  ConfigRecord,
  OpportunityEvidenceChain,
  PayloadRecord,
  ProfitRecord,
  RejectionRecord,
  RouteRecord,
  SettlementRecord,
  SettlementStatus,
  SimulationRecord,
  StateRecord,
  SubmissionResult,
} from '../../types/index.js';

export class EvidenceChain {
  private readonly opportunityId: string;
  private readonly configVersion: number;
  private readonly configHash: string;

  private _config?: ConfigRecord;
  private _state?: StateRecord;
  private _route?: RouteRecord;
  private _profit?: ProfitRecord;
  private _simulation?: SimulationRecord;
  private _payload?: PayloadRecord;
  private _submission?: SubmissionResult;
  private _settlement?: SettlementRecord;
  private _rejection?: RejectionRecord;

  // C1/C2 sub-records
  private _c1?: OpportunityEvidenceChain['c1'];
  private _c2?: OpportunityEvidenceChain['c2'];

  constructor(opportunityId: string, configVersion: number, configHash: string) {
    this.opportunityId = opportunityId;
    this.configVersion = configVersion;
    this.configHash = configHash;
  }

  // ── Setters ──────────────────────────────────────────────────────────────────

  setConfig(r: ConfigRecord): this { this._config = r; return this; }
  setState(r: StateRecord): this { this._state = r; return this; }
  setRoute(r: RouteRecord): this { this._route = r; return this; }
  setProfit(r: ProfitRecord): this { this._profit = r; return this; }
  setSimulation(r: SimulationRecord): this { this._simulation = r; return this; }
  setPayload(r: PayloadRecord): this { this._payload = r; return this; }
  setSubmission(r: SubmissionResult): this { this._submission = r; return this; }
  setSettlement(r: SettlementRecord): this { this._settlement = r; return this; }
  setRejection(r: RejectionRecord): this { this._rejection = r; return this; }
  setC1(r: NonNullable<OpportunityEvidenceChain['c1']>): this { this._c1 = r; return this; }
  setC2(r: NonNullable<OpportunityEvidenceChain['c2']>): this { this._c2 = r; return this; }

  // ── Build ────────────────────────────────────────────────────────────────────

  build(): OpportunityEvidenceChain {
    const stateHash     = this._state?.stateHash ?? '0x0';
    const routeHash     = this._route?.routeHash ?? '0x0';
    const simulationHash = this._simulation?.simulationHash;
    const payloadHash   = this._payload?.payloadHash;
    const txHash        = this._submission?.txHash;

    const settlementStatus: SettlementStatus | undefined =
      this._settlement?.settlementStatus ??
      (this._rejection ? 'FAILED' : undefined);

    const realizedNetUsd = this._settlement?.realizedNetUsd;

    return {
      opportunityId:   this.opportunityId,
      configVersion:   this.configVersion,
      configHash:      this.configHash,
      stateHash,
      routeHash,
      simulationHash,
      payloadHash,
      txHash,
      settlementStatus,
      realizedNetUsd,
      config:          this._config,
      state:           this._state,
      route:           this._route,
      profit:          this._profit,
      simulation:      this._simulation,
      payload:         this._payload,
      submission:      this._submission,
      settlement:      this._settlement,
      rejection:       this._rejection,
      c1:              this._c1,
      c2:              this._c2,
    };
  }

  /**
   * Returns a compact keccak256 hash of the complete evidence chain.
   * Use this as a persistent record key.
   */
  chainHash(): string {
    return keccak256(toUtf8Bytes(JSON.stringify(this.build())));
  }
}
