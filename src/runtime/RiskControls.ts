import { QUOTE_MAX_AGE_MS } from "../config";
import type { ArbitrageOpportunity } from "../ranking/OpportunityRanker";

export interface RiskAssessment {
  allowed: boolean;
  flags: string[];
}

export function assessOpportunityRisk(
  opportunity: ArbitrageOpportunity
): RiskAssessment {
  const flags: string[] = [];

  if (opportunity.quoteAgeMs > QUOTE_MAX_AGE_MS) {
    flags.push("stale_quotes");
  }
  if (opportunity.priceImpactBuy > 0.05 || opportunity.priceImpactSell > 0.05) {
    flags.push("elevated_price_impact");
  }
  if (opportunity.routeKind === "multi_hop" && !opportunity.multiHopRoute?.valid) {
    flags.push("invalid_multi_hop_route");
  }
  if (opportunity.tokenQuote === "USDC" || opportunity.tokenQuote === "USDT" || opportunity.tokenQuote === "DAI") {
    const stableDrift = Math.max(
      Math.abs(opportunity.buyQuote.price - opportunity.sellQuote.price) /
        Math.max(opportunity.buyQuote.price, 1e-9),
      0
    );
    if (stableDrift > 0.03) {
      flags.push("stable_pair_dislocation");
    }
  }

  return { allowed: flags.length === 0, flags };
}
