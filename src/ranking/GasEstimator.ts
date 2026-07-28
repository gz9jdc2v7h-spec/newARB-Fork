import { ethers } from "ethers";
import { withRetry } from "../utils/helpers";
import { logger } from "../utils/logger";
import { MAX_GAS_PRICE_GWEI } from "../config";

// Cache gas price for one block to avoid hammering the RPC
let cachedGasData: { baseFee: bigint; maxPriorityFee: bigint; ts: number } | null = null;
const CACHE_TTL_MS = 1_000; // 1 s — refresh each block

export interface GasData {
  baseFee: bigint;       // wei
  maxPriorityFee: bigint; // wei (tip)
  maxFeePerGas: bigint;  // 2 * baseFee + tip (EIP-1559)
  gasPriceGwei: number;
}

export async function getGasData(provider: ethers.Provider): Promise<GasData> {
  const now = Date.now();
  if (cachedGasData && now - cachedGasData.ts < CACHE_TTL_MS) {
    const { baseFee, maxPriorityFee } = cachedGasData;
    return buildGasData(baseFee, maxPriorityFee);
  }

  const feeData = await withRetry(() => provider.getFeeData());
  // Derive baseFee: maxFeePerGas - maxPriorityFeePerGas (EIP-1559)
  const maxFee = feeData.maxFeePerGas ?? ethers.parseUnits("0.1", "gwei");
  const maxPriorityFee = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("0.01", "gwei");
  const baseFee = maxFee > maxPriorityFee ? (maxFee - maxPriorityFee) / 2n : 0n;

  cachedGasData = { baseFee, maxPriorityFee, ts: now };

  const data = buildGasData(baseFee, maxPriorityFee);

  logger.debug("Gas data refreshed", {
    baseFeeGwei: Number(ethers.formatUnits(baseFee, "gwei")).toFixed(4),
    maxPriorityFeeGwei: Number(ethers.formatUnits(maxPriorityFee, "gwei")).toFixed(4),
    maxFeeGwei: data.gasPriceGwei.toFixed(4),
  });

  return data;
}

function buildGasData(baseFee: bigint, maxPriorityFee: bigint): GasData {
  // EIP-1559: maxFeePerGas = 2 * baseFee + maxPriorityFee (buffer for next block)
  const maxFeePerGas = 2n * baseFee + maxPriorityFee;

  const configMaxWei = ethers.parseUnits(String(MAX_GAS_PRICE_GWEI), "gwei");
  const effectiveMax = maxFeePerGas < configMaxWei ? maxFeePerGas : configMaxWei;

  return {
    baseFee,
    maxPriorityFee,
    maxFeePerGas: effectiveMax,
    gasPriceGwei: Number(ethers.formatUnits(effectiveMax, "gwei")),
  };
}

/**
 * Estimates the gas cost in USD for a swap of `gasUnits` units.
 * Requires an ETH/USD price (from the price matrix).
 */
export function estimateGasCostUsd(
  gasUnits: bigint,
  gasData: GasData,
  ethPriceUsd: number
): number {
  const costWei = gasUnits * gasData.maxFeePerGas;
  const costEth = Number(ethers.formatEther(costWei));
  return costEth * ethPriceUsd;
}
