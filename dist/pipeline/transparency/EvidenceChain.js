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
export class EvidenceChain {
    opportunityId;
    configVersion;
    configHash;
    _config;
    _state;
    _route;
    _profit;
    _simulation;
    _payload;
    _submission;
    _settlement;
    _rejection;
    // C1/C2 sub-records
    _c1;
    _c2;
    constructor(opportunityId, configVersion, configHash) {
        this.opportunityId = opportunityId;
        this.configVersion = configVersion;
        this.configHash = configHash;
    }
    // ── Setters ──────────────────────────────────────────────────────────────────
    setConfig(r) { this._config = r; return this; }
    setState(r) { this._state = r; return this; }
    setRoute(r) { this._route = r; return this; }
    setProfit(r) { this._profit = r; return this; }
    setSimulation(r) { this._simulation = r; return this; }
    setPayload(r) { this._payload = r; return this; }
    setSubmission(r) { this._submission = r; return this; }
    setSettlement(r) { this._settlement = r; return this; }
    setRejection(r) { this._rejection = r; return this; }
    setC1(r) { this._c1 = r; return this; }
    setC2(r) { this._c2 = r; return this; }
    // ── Build ────────────────────────────────────────────────────────────────────
    build() {
        const stateHash = this._state?.stateHash ?? '0x0';
        const routeHash = this._route?.routeHash ?? '0x0';
        const simulationHash = this._simulation?.simulationHash;
        const payloadHash = this._payload?.payloadHash;
        const txHash = this._submission?.txHash;
        const settlementStatus = this._settlement?.settlementStatus ??
            (this._rejection ? 'FAILED' : undefined);
        const realizedNetUsd = this._settlement?.realizedNetUsd;
        return {
            opportunityId: this.opportunityId,
            configVersion: this.configVersion,
            configHash: this.configHash,
            stateHash,
            routeHash,
            simulationHash,
            payloadHash,
            txHash,
            settlementStatus,
            realizedNetUsd,
            config: this._config,
            state: this._state,
            route: this._route,
            profit: this._profit,
            simulation: this._simulation,
            payload: this._payload,
            submission: this._submission,
            settlement: this._settlement,
            rejection: this._rejection,
            c1: this._c1,
            c2: this._c2,
        };
    }
    /**
     * Returns a compact keccak256 hash of the complete evidence chain.
     * Use this as a persistent record key.
     */
    chainHash() {
        return keccak256(toUtf8Bytes(JSON.stringify(this.build())));
    }
}
//# sourceMappingURL=EvidenceChain.js.map