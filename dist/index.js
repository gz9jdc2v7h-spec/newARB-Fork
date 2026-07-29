"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const ethers_1 = require("ethers");
const config_1 = require("./config");
const OpportunityScanner_1 = require("./discovery/OpportunityScanner");
const OpportunityRanker_1 = require("./ranking/OpportunityRanker");
const Executor_1 = require("./execution/Executor");
const logger_1 = require("./utils/logger");
const helpers_1 = require("./utils/helpers");
const RuntimeEventStream_1 = require("./runtime/RuntimeEventStream");
const RiskControls_1 = require("./runtime/RiskControls");
const ExecutionPolicy_1 = require("./runtime/ExecutionPolicy");
const AtomicFlashExecutor_1 = require("./runtime/AtomicFlashExecutor");
const ObservabilityReporter_1 = require("./runtime/ObservabilityReporter");
// ─── Provider setup ───────────────────────────────────────────────────────────
async function createHttpProvider() {
    let lastErr;
    for (const url of config_1.RPC_HTTP_CANDIDATES) {
        try {
            const p = new ethers_1.ethers.JsonRpcProvider(url, config_1.CHAIN_ID);
            const network = await p.getNetwork();
            if (network.chainId !== BigInt(config_1.CHAIN_ID)) {
                throw new Error(`Endpoint ${url} is chain ${network.chainId}, expected ${config_1.CHAIN_ID}`);
            }
            logger_1.logger.info("HTTP provider selected", { url });
            return p;
        }
        catch (err) {
            lastErr = err;
            logger_1.logger.warn("HTTP endpoint unavailable", { url, err: String(err) });
        }
    }
    throw new Error(`No reachable HTTP Polygon endpoint. Last error: ${String(lastErr)}`);
}
async function createWsProvider() {
    for (const url of config_1.RPC_WS_CANDIDATES) {
        try {
            const p = new ethers_1.ethers.WebSocketProvider(url, config_1.CHAIN_ID);
            const block = await p.getBlockNumber();
            logger_1.logger.info("WebSocket provider selected", { url, block });
            return p;
        }
        catch (err) {
            logger_1.logger.warn("WebSocket endpoint unavailable", { url, err: String(err) });
        }
    }
    logger_1.logger.warn("No reachable WebSocket endpoint — will use HTTP polling");
    return null;
}
// ─── Main loop ────────────────────────────────────────────────────────────────
async function main() {
    logger_1.logger.info("=== Polygon ARB Bot starting ===");
    const httpProvider = await createHttpProvider();
    const wsProvider = await createWsProvider();
    const eventStream = new RuntimeEventStream_1.RuntimeEventStream();
    const observability = new ObservabilityReporter_1.ObservabilityReporter(eventStream);
    eventStream.on((event) => {
        if (event.kind === "health" && event.status !== "ok") {
            logger_1.logger.warn("Runtime event", event);
        }
        else if (event.kind !== "pending_tx") {
            logger_1.logger.debug("Runtime event", event);
        }
    });
    observability.logConfig({
        configVersion: 1,
        configHash: "runtime-config",
        mode: process.env["PRIVATE_KEY"] ? "live" : "dry_run",
        minNetProfitUsd: process.env["MIN_PROFIT_USD"] ?? "0",
        minProfitToGasRatio: "0",
        maxPoolUsageRatio: "1",
        privateRelayFirst: Boolean(config_1.PRIVATE_RELAY_ENDPOINT),
        publicFallback: config_1.PUBLIC_FALLBACK,
        killSwitch: false,
        c2Enabled: false,
        enabledVenues: ["UniswapV3", "SushiSwapV2", "QuickSwapV2", "BalancerV2", "Curve"],
        enabledAssets: ["WMATIC", "WETH", "USDC", "USDT", "DAI", "WBTC"],
        gasCap: "0",
    }, "runtime");
    // Verify network
    const network = await httpProvider.getNetwork();
    if (network.chainId !== BigInt(config_1.CHAIN_ID)) {
        throw new Error(`Wrong network: expected chain ${config_1.CHAIN_ID}, got ${network.chainId}`);
    }
    logger_1.logger.info(`Connected to chain ${network.chainId} (${network.name})`);
    const ranker = new OpportunityRanker_1.OpportunityRanker(httpProvider);
    // Only create executor when PRIVATE_KEY is set
    let executor = null;
    if (process.env["PRIVATE_KEY"]) {
        executor = new Executor_1.Executor(httpProvider, eventStream);
        logger_1.logger.info("Executor initialised — LIVE execution enabled");
    }
    else {
        logger_1.logger.warn("PRIVATE_KEY not set — running in DRY-RUN mode (discovery + ranking only)");
    }
    const atomicFlashExecutor = config_1.ENABLE_ATOMIC_FLASH && config_1.FLASH_EXECUTOR_ADDRESS
        ? new AtomicFlashExecutor_1.AtomicFlashExecutor(eventStream)
        : null;
    // Debounce: ensure we don't process overlapping snapshots
    let processing = false;
    const handleSnapshot = async (snapshot) => {
        if (processing) {
            logger_1.logger.debug("Skipping snapshot — previous still processing");
            return;
        }
        processing = true;
        try {
            const opportunities = await ranker.rank(snapshot);
            if (opportunities.length === 0) {
                logger_1.logger.debug("No profitable opportunities found");
                return;
            }
            const best = opportunities[0];
            observability.recordDiscovery(best);
            logger_1.logger.info("Best opportunity", {
                label: best.label,
                grossUsd: best.grossProfitUsd.toFixed(2),
                gasUsd: best.gasCostUsd.toFixed(2),
                netUsd: best.netProfitUsd.toFixed(2),
                score: best.score.toFixed(2),
                invariantFamilies: best.invariantFamilies,
                sizingMethod: best.sizingMethod,
                quoteAgeMs: best.quoteAgeMs,
                routeKind: best.routeKind,
            });
            if (executor) {
                const risk = (0, RiskControls_1.assessOpportunityRisk)(best);
                const decision = (0, ExecutionPolicy_1.decideExecutionMode)({
                    hasPrivateKey: Boolean(process.env["PRIVATE_KEY"]),
                    routeKind: best.routeKind,
                    hasExecutableMultiHopRoute: Boolean(best.multiHopRoute?.valid),
                    requiresFlashLoan: best.routeKind === "multi_hop",
                    quoteAgeMs: best.quoteAgeMs,
                    supportsPrivateRelay: Boolean(config_1.PRIVATE_RELAY_ENDPOINT),
                    supportsAtomicFlash: Boolean(atomicFlashExecutor),
                    expectedNetProfitUsd: best.netProfitUsd,
                    riskFlags: risk.flags,
                });
                observability.recordDecision(best.label, decision);
                logger_1.logger.info("Execution decision", decision);
                if (decision.shouldExecute && decision.mode === "sequential_live") {
                    await executor.execute(best);
                }
                else if (decision.shouldExecute && decision.mode === "private_relay_live") {
                    await executor.execute(best);
                }
                else if (decision.shouldExecute && decision.mode === "atomic_flash" && atomicFlashExecutor) {
                    const currentBlock = await httpProvider.getBlockNumber();
                    await atomicFlashExecutor.execute(best, currentBlock);
                }
                else if (!decision.shouldExecute) {
                    eventStream.publishHealth("risk", "paused", `Execution paused: ${decision.rationale} (${decision.riskFlags.join(",") || "no-flags"})`, "risk");
                }
            }
        }
        finally {
            processing = false;
            observability.publishHealth();
        }
    };
    const scanner = new OpportunityScanner_1.OpportunityScanner(httpProvider, wsProvider, handleSnapshot, eventStream);
    scanner.start();
    // Keep alive — handle graceful shutdown
    const shutdown = async () => {
        logger_1.logger.info("Shutting down...");
        scanner.stop();
        if (wsProvider) {
            await wsProvider.destroy();
        }
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    while (true) {
        await (0, helpers_1.sleep)(60_000);
        logger_1.logger.debug("Heartbeat — bot is running");
    }
}
main().catch((err) => {
    logger_1.logger.error("Fatal error", { err: String(err) });
    process.exit(1);
});
//# sourceMappingURL=index.js.map