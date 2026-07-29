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
import type { ConfigRecord, OpportunityEvidenceChain, PayloadRecord, ProfitRecord, RejectionRecord, RouteRecord, SettlementRecord, SimulationRecord, StateRecord, SubmissionResult } from '../../types/index.js';
export declare class EvidenceChain {
    private readonly opportunityId;
    private readonly configVersion;
    private readonly configHash;
    private _config?;
    private _state?;
    private _route?;
    private _profit?;
    private _simulation?;
    private _payload?;
    private _submission?;
    private _settlement?;
    private _rejection?;
    private _c1?;
    private _c2?;
    constructor(opportunityId: string, configVersion: number, configHash: string);
    setConfig(r: ConfigRecord): this;
    setState(r: StateRecord): this;
    setRoute(r: RouteRecord): this;
    setProfit(r: ProfitRecord): this;
    setSimulation(r: SimulationRecord): this;
    setPayload(r: PayloadRecord): this;
    setSubmission(r: SubmissionResult): this;
    setSettlement(r: SettlementRecord): this;
    setRejection(r: RejectionRecord): this;
    setC1(r: NonNullable<OpportunityEvidenceChain['c1']>): this;
    setC2(r: NonNullable<OpportunityEvidenceChain['c2']>): this;
    build(): OpportunityEvidenceChain;
    /**
     * Returns a compact keccak256 hash of the complete evidence chain.
     * Use this as a persistent record key.
     */
    chainHash(): string;
}
//# sourceMappingURL=EvidenceChain.d.ts.map