// Minimal ABIs — only the functions needed for price discovery.

export const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
] as const;

export const UNIV2_PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
] as const;

export const UNIV2_FACTORY_ABI = [
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
] as const;

export const UNIV3_QUOTER_V2_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "uint24", name: "fee", type: "uint24" },
          {
            internalType: "uint160",
            name: "sqrtPriceLimitX96",
            type: "uint160",
          },
        ],
        internalType: "struct IQuoterV2.QuoteExactInputSingleParams",
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { internalType: "uint256", name: "amountOut", type: "uint256" },
      {
        internalType: "uint160",
        name: "sqrtPriceX96After",
        type: "uint160",
      },
      {
        internalType: "uint32",
        name: "initializedTicksCrossed",
        type: "uint32",
      },
      { internalType: "uint256", name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export const UNIV3_ROUTER_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "uint24", name: "fee", type: "uint24" },
          { internalType: "address", name: "recipient", type: "address" },
          {
            internalType: "uint256",
            name: "amountIn",
            type: "uint256",
          },
          {
            internalType: "uint256",
            name: "amountOutMinimum",
            type: "uint256",
          },
          {
            internalType: "uint160",
            name: "sqrtPriceLimitX96",
            type: "uint160",
          },
        ],
        internalType: "struct IV3SwapRouter.ExactInputSingleParams",
        name: "params",
        type: "tuple",
      },
    ],
    name: "exactInputSingle",
    outputs: [
      { internalType: "uint256", name: "amountOut", type: "uint256" },
    ],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export const UNIV2_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)",
] as const;

export const AAVE_POOL_ABI = [
  {
    inputs: [
      { internalType: "address", name: "receiverAddress", type: "address" },
      { internalType: "address[]", name: "assets", type: "address[]" },
      { internalType: "uint256[]", name: "amounts", type: "uint256[]" },
      { internalType: "uint256[]", name: "interestRateModes", type: "uint256[]" },
      { internalType: "address", name: "onBehalfOf", type: "address" },
      { internalType: "bytes", name: "params", type: "bytes" },
      { internalType: "uint16", name: "referralCode", type: "uint16" },
    ],
    name: "flashLoan",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ─── Balancer V2 Vault ────────────────────────────────────────────────────────

export const BALANCER_VAULT_ABI = [
  // Read pool token list and balances (used to resolve asset indices for quotes)
  {
    inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }],
    name: "getPoolTokens",
    outputs: [
      { internalType: "address[]", name: "tokens", type: "address[]" },
      { internalType: "uint256[]", name: "balances", type: "uint256[]" },
      { internalType: "uint256", name: "lastChangeBlock", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  // Simulate a batch swap without state changes — call via staticCall
  {
    inputs: [
      { internalType: "uint8", name: "kind", type: "uint8" },
      {
        components: [
          { internalType: "bytes32", name: "poolId", type: "bytes32" },
          { internalType: "uint256", name: "assetInIndex", type: "uint256" },
          { internalType: "uint256", name: "assetOutIndex", type: "uint256" },
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "bytes", name: "userData", type: "bytes" },
        ],
        internalType: "struct IVault.BatchSwapStep[]",
        name: "swaps",
        type: "tuple[]",
      },
      { internalType: "address[]", name: "assets", type: "address[]" },
      {
        components: [
          { internalType: "address", name: "sender", type: "address" },
          { internalType: "bool", name: "fromInternalBalance", type: "bool" },
          { internalType: "address payable", name: "recipient", type: "address" },
          { internalType: "bool", name: "toInternalBalance", type: "bool" },
        ],
        internalType: "struct IVault.FundManagement",
        name: "funds",
        type: "tuple",
      },
    ],
    name: "queryBatchSwap",
    outputs: [
      { internalType: "int256[]", name: "assetDeltas", type: "int256[]" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Execute a batch swap (used in atomic execution path)
  {
    inputs: [
      { internalType: "uint8", name: "kind", type: "uint8" },
      {
        components: [
          { internalType: "bytes32", name: "poolId", type: "bytes32" },
          { internalType: "uint256", name: "assetInIndex", type: "uint256" },
          { internalType: "uint256", name: "assetOutIndex", type: "uint256" },
          { internalType: "uint256", name: "amount", type: "uint256" },
          { internalType: "bytes", name: "userData", type: "bytes" },
        ],
        internalType: "struct IVault.BatchSwapStep[]",
        name: "swaps",
        type: "tuple[]",
      },
      { internalType: "address[]", name: "assets", type: "address[]" },
      {
        components: [
          { internalType: "address", name: "sender", type: "address" },
          { internalType: "bool", name: "fromInternalBalance", type: "bool" },
          { internalType: "address payable", name: "recipient", type: "address" },
          { internalType: "bool", name: "toInternalBalance", type: "bool" },
        ],
        internalType: "struct IVault.FundManagement",
        name: "funds",
        type: "tuple",
      },
      { internalType: "int256[]", name: "limits", type: "int256[]" },
      { internalType: "uint256", name: "deadline", type: "uint256" },
    ],
    name: "batchSwap",
    outputs: [
      { internalType: "int256[]", name: "assetDeltas", type: "int256[]" },
    ],
    stateMutability: "payable",
    type: "function",
  },
] as const;
