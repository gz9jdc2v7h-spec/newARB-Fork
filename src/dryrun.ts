/**
 * DRY-RUN: 25-Cycle Discovery Runner
 *
 * Executes exactly 25 scan → rank cycles against the live Polygon endpoints.
 * No wallet / PRIVATE_KEY is required. Every trade is simulated only.
 * Prints the Top-10 ranked arbitrage routes per cycle to stdout.
 *
 * Usage:
 *   npx ts-node src/dryrun.ts
 *   # or after build:
 *   node dist/dryrun.js
 */
import "dotenv/config";
import { ethers } from "ethers";
import { RPC_HTTP, RPC_HTTP_FALLBACK, CHAIN_ID } from "./config";
import { scanAllPairs } from "./discovery/OpportunityScanner";
import { OpportunityRanker, ArbitrageOpportunity } from "./ranking/OpportunityRanker";
import { logger } from "./utils/logger";

// ─── Configuration ────────────────────────────────────────────────────────────

const TOTAL_CYCLES = 25;
const TOP_N = 10;

// ─── Provider ────────────────────────────────────────────────────────────────

function createProvider(): ethers.JsonRpcProvider {
  try {
    const p = new ethers.JsonRpcProvider(RPC_HTTP, CHAIN_ID);
    logger.info("HTTP provider ready", { url: RPC_HTTP });
    return p;
  } catch {
    logger.warn("Primary RPC failed — using fallback", { fallback: RPC_HTTP_FALLBACK });
    return new ethers.JsonRpcProvider(RPC_HTTP_FALLBACK, CHAIN_ID);
  }
}

// ─── Pretty printer ───────────────────────────────────────────────────────────

function printCycleHeader(cycle: number, blockNumber: number | null): void {
  const divider = "═".repeat(100);
  process.stdout.write(`\n${divider}\n`);
  process.stdout.write(
    `  CYCLE ${String(cycle).padStart(2, "0")} / ${TOTAL_CYCLES}` +
    (blockNumber !== null ? `   block #${blockNumber}` : "") +
    `   ${new Date().toISOString()}\n`
  );
  process.stdout.write(`${divider}\n`);
}

function printTopRoutes(routes: ArbitrageOpportunity[]): void {
  if (routes.length === 0) {
    process.stdout.write("  ⚠  No profitable opportunities found this cycle.\n");
    return;
  }

  // Column widths
  const COL = {
    rank:    4,
    label:   46,
    gross:   11,
    gas:     10,
    net:     10,
    size:    12,
    piB:     8,
    piS:     8,
    kelly:   9,
    mh:      4,
  };

  const header =
    " #".padEnd(COL.rank) +
    " Route".padEnd(COL.label) +
    " Gross $".padStart(COL.gross) +
    " Gas $".padStart(COL.gas) +
    " Net $".padStart(COL.net) +
    " Size $".padStart(COL.size) +
    " PI-buy".padStart(COL.piB) +
    " PI-sel".padStart(COL.piS) +
    " Kelly".padStart(COL.kelly) +
    " MH";

  const separator = "─".repeat(header.length);
  process.stdout.write(`  ${separator}\n`);
  process.stdout.write(`  ${header}\n`);
  process.stdout.write(`  ${separator}\n`);

  routes.forEach((opp, idx) => {
    const rank   = String(idx + 1).padStart(COL.rank - 1);
    const label  = opp.label.slice(0, COL.label - 1).padEnd(COL.label - 1);
    const gross  = `$${opp.grossProfitUsd.toFixed(2)}`.padStart(COL.gross - 1);
    const gas    = `$${opp.gasCostUsd.toFixed(2)}`.padStart(COL.gas - 1);
    const net    = `$${opp.netProfitUsd.toFixed(2)}`.padStart(COL.net - 1);
    const size   = `$${opp.tradeAmountInUsd.toFixed(0)}`.padStart(COL.size - 1);
    const piB    = `${(opp.priceImpactBuy * 100).toFixed(2)}%`.padStart(COL.piB - 1);
    const piS    = `${(opp.priceImpactSell * 100).toFixed(2)}%`.padStart(COL.piS - 1);
    const kelly  = opp.score.toFixed(4).padStart(COL.kelly - 1);
    const mh     = opp.isMultiHop ? "🔄" : "  ";

    process.stdout.write(`  ${rank} ${label} ${gross} ${gas} ${net} ${size} ${piB} ${piS} ${kelly} ${mh}\n`);
  });

  process.stdout.write(`  ${separator}\n`);
}

function printCycleSummary(
  cycle: number,
  totalPairs: number,
  totalQuotes: number,
  totalOpportunities: number,
  routes: ArbitrageOpportunity[]
): void {
  process.stdout.write(
    `\n  📊 Cycle ${cycle} summary: ` +
    `${totalPairs} pairs scanned | ` +
    `${totalQuotes} quotes fetched | ` +
    `${totalOpportunities} profitable route(s) found\n`
  );
  if (routes.length > 0) {
    const best = routes[0]!;
    process.stdout.write(
      `  🏆 Best route: ${best.label}  ` +
      `net=$${best.netProfitUsd.toFixed(2)}  ` +
      `kelly=${best.score.toFixed(4)}\n`
    );
  }
}

function printFinalSummary(allRoutes: ArbitrageOpportunity[][]): void {
  const divider = "═".repeat(100);
  process.stdout.write(`\n${divider}\n`);
  process.stdout.write(`  DRY-RUN COMPLETE — ${TOTAL_CYCLES} CYCLES   ${new Date().toISOString()}\n`);
  process.stdout.write(`${divider}\n`);

  // Aggregate across all cycles
  const flat = allRoutes.flat();
  if (flat.length === 0) {
    process.stdout.write("  No profitable opportunities were found across all cycles.\n");
    return;
  }

  // Best net profit seen overall
  const bestNet = flat.reduce((best, r) => (r.netProfitUsd > best.netProfitUsd ? r : best));
  // Best Kelly score seen overall
  const bestKelly = flat.reduce((best, r) => (r.score > best.score ? r : best));
  // Average top-1 net profit per cycle
  const topPerCycle = allRoutes.map((r) => r[0]?.netProfitUsd ?? 0);
  const avgNet = topPerCycle.reduce((a, b) => a + b, 0) / topPerCycle.length;

  process.stdout.write(
    `  Total profitable routes across all cycles : ${flat.length}\n` +
    `  Best net profit route  : ${bestNet.label}  $${bestNet.netProfitUsd.toFixed(2)}\n` +
    `  Best Kelly score route : ${bestKelly.label}  ${bestKelly.score.toFixed(4)}\n` +
    `  Avg top-1 net profit/cycle : $${avgNet.toFixed(2)}\n`
  );
  process.stdout.write(`${divider}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdout.write("\n");
  process.stdout.write("╔══════════════════════════════════════════════════════════════════════╗\n");
  process.stdout.write("║  POLYGON ARB-BOT  ·  DRY-RUN  ·  25-CYCLE DISCOVERY  ·  LIVE ENDPOINTS      ║\n");
  process.stdout.write("║  No PRIVATE_KEY required — zero on-chain transactions will be sent.  ║\n");
  process.stdout.write("╚══════════════════════════════════════════════════════════════════════╝\n\n");

  const provider = createProvider();

  // Verify network
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(CHAIN_ID)) {
    throw new Error(`Wrong network: expected ${CHAIN_ID}, got ${network.chainId}`);
  }
  logger.info(`Connected to chain ${network.chainId} (${network.name ?? "unknown"})`);

  const ranker = new OpportunityRanker(provider);

  const allTopRoutes: ArbitrageOpportunity[][] = [];

  for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
    // ── Current block ───────────────────────────────────────────────────────
    let blockNumber: number | null = null;
    try {
      blockNumber = await provider.getBlockNumber();
    } catch {
      // non-fatal — block number is only cosmetic in the header
    }

    printCycleHeader(cycle, blockNumber);
    logger.info(`Cycle ${cycle}/${TOTAL_CYCLES}: scanning all pairs...`);

    // ── Scan ────────────────────────────────────────────────────────────────
    let snapshot;
    try {
      snapshot = await scanAllPairs(provider);
    } catch (err) {
      logger.error(`Scan failed on cycle ${cycle}`, { err: String(err) });
      process.stdout.write(`  ❌ Scan error: ${String(err)}\n`);
      allTopRoutes.push([]);
      continue;
    }

    const totalPairs  = snapshot.length;
    const totalQuotes = snapshot.reduce((s, p) => s + p.quotes.length, 0);

    // ── Rank ────────────────────────────────────────────────────────────────
    let ranked: ArbitrageOpportunity[];
    try {
      ranked = await ranker.rank(snapshot);
    } catch (err) {
      logger.error(`Ranking failed on cycle ${cycle}`, { err: String(err) });
      process.stdout.write(`  ❌ Ranking error: ${String(err)}\n`);
      allTopRoutes.push([]);
      continue;
    }

    const top = ranked.slice(0, TOP_N);
    allTopRoutes.push(top);

    printTopRoutes(top);
    printCycleSummary(cycle, totalPairs, totalQuotes, ranked.length, top);
  }

  printFinalSummary(allTopRoutes);
}

main().catch((err) => {
  logger.error("Fatal error", { err: String(err) });
  process.exit(1);
});
