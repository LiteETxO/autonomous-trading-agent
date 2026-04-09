/**
 * dex-agent-tools.js
 * DEX trading layer for the autonomous agent
 * Covers: Hyperliquid · Uniswap v3 · dYdX v4 · GMX v2
 *
 * ─── SECURITY FIRST ──────────────────────────────────────────────────────────
 * DEX trades are signed on-chain. Mistakes are IRREVERSIBLE.
 * Never commit private keys. Use env vars + a hardware wallet where possible.
 *
 * Recommended wallet setup:
 *   1. Create a dedicated hot wallet (e.g. `cast wallet new` via Foundry)
 *   2. Bridge ONLY what you're willing to lose to that address
 *   3. Store the private key in a secrets manager (AWS Secrets Manager,
 *      HashiCorp Vault) — never plain .env in a git repo
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Install:
 *   npm install ethers @hyperliquid/sdk @dydxprotocol/v4-client-js
 *
 * Env vars required:
 *   WALLET_PRIVATE_KEY        — EVM hot wallet (used for HL, Uniswap, GMX)
 *   DYDX_MNEMONIC             — dYdX v4 uses a Cosmos wallet (24-word mnemonic)
 *   ETHEREUM_RPC_URL          — e.g. https://mainnet.infura.io/v3/YOUR_KEY
 *   ARBITRUM_RPC_URL          — for GMX + Uniswap on Arbitrum
 */

import { ethers }                   from "ethers";

let HyperliquidSDK = null;
async function loadHL() {
  if (HyperliquidSDK) return HyperliquidSDK;
  try {
    const mod = await import("@nktkas/hyperliquid");
    HyperliquidSDK = mod.Hyperliquid || mod.default;
  } catch {
    throw new Error("Hyperliquid SDK not installed. Run: npm install @nktkas/hyperliquid");
  }
  return HyperliquidSDK;
}
// dYdX imports loaded lazily to avoid crash on Node 22 compatibility issue
let CompositeClient, Network, LocalWallet, OrderSide, OrderType, OrderTimeInForce;
async function loadDydx() {
  if (CompositeClient) return;
  try {
    ({ CompositeClient, Network, LocalWallet, OrderSide, OrderType, OrderTimeInForce }
      = await import("@dydxprotocol/v4-client-js"));
  } catch (e) {
    throw new Error(`dYdX unavailable: ${e.message}`);
  }
}

// ─── Shared config ────────────────────────────────────────────────────────────

const MAX_ORDER_USD    = 100;          // hard cap shared across all venues
const DEFAULT_SLIPPAGE = 0.005;        // 0.5% slippage tolerance

const EVM_WALLET = () => {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key || key.startsWith("0x...") || key.length < 32)
    throw new Error("WALLET_PRIVATE_KEY not configured — DEX trading unavailable");
  return new ethers.Wallet(key);
};

// ─── Safety guard (shared) ────────────────────────────────────────────────────

function sizeGuard(usdValue) {
  if (usdValue > MAX_ORDER_USD) {
    return {
      blocked: true,
      message: `Order REJECTED — size guard: $${usdValue.toFixed(2)} > $${MAX_ORDER_USD} limit`,
    };
  }
  return { blocked: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HYPERLIQUID
// Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
// Supports: spot + perps, up to 50x leverage
// Chain: Hyperliquid L1 (EVM-compatible, gasless)
// ═══════════════════════════════════════════════════════════════════════════════

let _hl = null;
async function getHL() {
  if (!_hl) {
    const Hyperliquid = await loadHL();
    const wallet = EVM_WALLET();
    _hl = new Hyperliquid({ privateKey: wallet.privateKey, testnet: process.env.HL_TESTNET !== "false" });
  }
  return _hl;
}

/**
 * Get Hyperliquid account summary (balances + open positions).
 */
export async function hlGetAccount() {
  const wallet = EVM_WALLET();
  const hl = getHL();
  const state = await hl.info.perpetuals.getClearinghouseState(wallet.address);
  const spot  = await hl.info.spot.getSpotClearinghouseState(wallet.address);

  const perp_equity = parseFloat(state.marginSummary?.accountValue || 0);
  const positions   = (state.assetPositions || [])
    .filter(p => parseFloat(p.position?.szi || 0) !== 0)
    .map(p => `${p.position.coin} ${p.position.szi} (pnl: $${parseFloat(p.position.unrealizedPnl||0).toFixed(2)})`);

  return [
    `Hyperliquid account: ${wallet.address}`,
    `Perp equity: $${perp_equity.toFixed(2)}`,
    `Open positions: ${positions.length ? positions.join(", ") : "none"}`,
  ].join("\n");
}

/**
 * Place a Hyperliquid perp order.
 * @param {string}  coin        e.g. "ETH"
 * @param {boolean} isBuy
 * @param {number}  sz          size in base coin
 * @param {number}  limitPx     limit price (use current price for pseudo-market)
 * @param {boolean} reduceOnly
 */
export async function hlPlacePerpOrder({ coin, side, sz, limitPx, reduceOnly = false, leverage = 1 }) {
  const guard = sizeGuard(sz * limitPx);
  if (guard.blocked) return guard.message;

  const hl     = getHL();
  const isBuy  = side.toLowerCase() === "buy";

  // Set leverage if changed
  if (leverage > 1) {
    await hl.exchange.updateLeverage({ coin, isCross: true, leverage });
  }

  const result = await hl.exchange.placeOrder({
    coin,
    isBuy,
    sz,
    limitPx,
    orderType: { limit: { tif: "Ioc" } }, // IOC = immediate-or-cancel (market-like)
    reduceOnly,
  });

  const filled = result?.response?.data?.statuses?.[0];
  return [
    `Hyperliquid perp order ${process.env.HL_TESTNET !== "false" ? "(TESTNET)" : "(LIVE)"}`,
    `  coin   : ${coin}-PERP`,
    `  side   : ${isBuy ? "BUY" : "SELL"}`,
    `  size   : ${sz}`,
    `  price  : $${limitPx}`,
    `  value  : $${(sz * limitPx).toFixed(2)}`,
    `  status : ${JSON.stringify(filled || result)}`,
  ].join("\n");
}

/**
 * Place a Hyperliquid spot order.
 */
export async function hlPlaceSpotOrder({ token, side, sz, limitPx }) {
  const guard = sizeGuard(sz * limitPx);
  if (guard.blocked) return guard.message;

  const hl    = getHL();
  const isBuy = side.toLowerCase() === "buy";

  const result = await hl.exchange.placeOrder({
    coin:      `@${token}`, // spot coins are prefixed with @ on HL
    isBuy,
    sz,
    limitPx,
    orderType: { limit: { tif: "Ioc" } },
    reduceOnly: false,
  });

  return [
    `Hyperliquid spot order`,
    `  token  : ${token}`,
    `  side   : ${isBuy ? "BUY" : "SELL"}`,
    `  sz     : ${sz}`,
    `  price  : $${limitPx}`,
    `  result : ${JSON.stringify(result?.response?.data?.statuses?.[0] || result)}`,
  ].join("\n");
}

/**
 * Get Hyperliquid market data (mid price + 24h stats).
 */
export async function hlGetMarket({ coin }) {
  const hl   = getHL();
  const meta = await hl.info.perpetuals.getMeta();
  const ctx  = await hl.info.perpetuals.getMetaAndAssetCtxs();
  const idx  = meta.universe.findIndex(u => u.name === coin.toUpperCase());
  if (idx < 0) return `Coin ${coin} not found on Hyperliquid`;
  const c = ctx[1][idx];
  return [
    `HL ${coin}-PERP`,
    `  Mark price : $${parseFloat(c.markPx).toFixed(4)}`,
    `  Funding    : ${(parseFloat(c.funding)*100).toFixed(4)}% / 8h`,
    `  Open int.  : $${(parseFloat(c.openInterest)*parseFloat(c.markPx)).toLocaleString()}`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNISWAP V3  (Ethereum mainnet + Arbitrum)
// Docs: https://docs.uniswap.org/sdk/v3/overview
// ═══════════════════════════════════════════════════════════════════════════════

// Swap Router v2 address (same on mainnet + most L2s)
const UNISWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNISWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256)",
  "function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) external payable returns (uint256)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Common token addresses (mainnet)
const TOKENS = {
  WETH:  { mainnet: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" },
  USDC:  { mainnet: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  USDT:  { mainnet: "0xdAC17F958D2ee523a2206206994597C13D831ec7", arbitrum: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" },
  WBTC:  { mainnet: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", arbitrum: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f" },
};

/**
 * Swap tokens on Uniswap V3.
 * @param {string} tokenIn   e.g. "USDC"
 * @param {string} tokenOut  e.g. "WETH"
 * @param {number} amountIn  in human units (e.g. 100 USDC)
 * @param {string} chain     "mainnet" | "arbitrum"
 * @param {number} feeTier   500 | 3000 | 10000 (0.05% | 0.3% | 1%)
 */
export async function uniswapSwap({ tokenIn, tokenOut, amountIn, chain = "arbitrum", feeTier = 3000 }) {
  const guard = sizeGuard(amountIn); // amountIn assumed to be USD-denominated input
  if (guard.blocked) return guard.message;

  const rpcUrl = chain === "arbitrum"
    ? process.env.ARBITRUM_RPC_URL
    : process.env.ETHEREUM_RPC_URL;
  if (!rpcUrl) return `Missing ${chain === "arbitrum" ? "ARBITRUM_RPC_URL" : "ETHEREUM_RPC_URL"} env var`;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer   = EVM_WALLET().connect(provider);

  const inAddr  = TOKENS[tokenIn.toUpperCase()]?.[chain];
  const outAddr = TOKENS[tokenOut.toUpperCase()]?.[chain];
  if (!inAddr || !outAddr) return `Unknown token pair: ${tokenIn}/${tokenOut} on ${chain}`;

  const inContract  = new ethers.Contract(inAddr, ERC20_ABI, signer);
  const decimalsIn  = await inContract.decimals();
  const amountInRaw = ethers.parseUnits(amountIn.toString(), decimalsIn);

  // Approve router
  await inContract.approve(UNISWAP_ROUTER, amountInRaw);

  const router   = new ethers.Contract(UNISWAP_ROUTER, UNISWAP_ROUTER_ABI, signer);
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const minOut   = 0n; // set via slippage calc in production; 0 = accept any (risky on large orders)

  const tx = await router.exactInputSingle({
    tokenIn:              inAddr,
    tokenOut:             outAddr,
    fee:                  feeTier,
    recipient:            signer.address,
    amountIn:             amountInRaw,
    amountOutMinimum:     minOut,
    sqrtPriceLimitX96:    0n,
  });

  const receipt = await tx.wait();
  return [
    `Uniswap V3 swap (${chain})`,
    `  ${amountIn} ${tokenIn} → ${tokenOut}`,
    `  fee tier : ${feeTier/10000}%`,
    `  tx hash  : ${receipt.hash}`,
    `  gas used : ${receipt.gasUsed.toString()}`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// dYdX V4  (Cosmos-based, gasless, perps only)
// Docs: https://docs.dydx.exchange/developers/clients/trading
// ═══════════════════════════════════════════════════════════════════════════════

let _dydx = null;
async function getDydx() {
  if (_dydx) return _dydx;
  const network = process.env.DYDX_TESTNET !== "false"
    ? Network.testnet()
    : Network.mainnet();
  _dydx = await CompositeClient.connect(network);
  return _dydx;
}

export async function dydxPlaceOrder({ market, side, size, price, leverage = 1 }) {
  await loadDydx();
  const guard = sizeGuard(size * price);
  if (guard.blocked) return guard.message;

  if (!process.env.DYDX_MNEMONIC) return "DYDX_MNEMONIC env var not set";

  const client    = await getDydx();
  const wallet    = await LocalWallet.fromMnemonic(process.env.DYDX_MNEMONIC, "dydx");
  const subaccount = new client.validatorClient.SubaccountClient(wallet, 0);

  const order = await client.placeOrder(
    subaccount,
    market.toUpperCase().replace("/","-") + "-USD",   // e.g. ETH-USD
    OrderType.LIMIT,
    side.toUpperCase() === "BUY" ? OrderSide.BUY : OrderSide.SELL,
    price,
    size,
    Date.now() + 60_000,     // good-til time: 60s
    OrderTimeInForce.GTT,
    false,                    // reduceOnly
    false                     // postOnly
  );

  return [
    `dYdX V4 order ${process.env.DYDX_TESTNET !== "false" ? "(TESTNET)" : "(LIVE)"}`,
    `  market : ${market}-USD`,
    `  side   : ${side.toUpperCase()}`,
    `  size   : ${size}`,
    `  price  : $${price}`,
    `  value  : $${(size * price).toFixed(2)}`,
    `  result : ${JSON.stringify(order)}`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// GMX V2  (Arbitrum · Avalanche — perps + spot)
// Docs: https://gmx-io.gitbook.io/gmx-documentation/gmx-contracts/contracts
// ═══════════════════════════════════════════════════════════════════════════════

// GMX Exchange Router on Arbitrum
const GMX_ROUTER   = "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6";
const GMX_READER   = "0x38d91ED96283d62182Fc6d990C24097A918a4d9b";
const GMX_ROUTER_ABI = [
  "function createOrder((address receiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath,uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,int256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,bool isLong,bool shouldUnwrapNativeToken)) payable external returns (bytes32)",
];

/**
 * Open or close a GMX V2 position.
 * GMX uses USD-denominated size (sizeDeltaUsd) rather than coin qty.
 */
export async function gmxPlaceOrder({ market, side, sizeUsd, collateralToken = "USDC", triggerPrice = 0 }) {
  const guard = sizeGuard(sizeUsd);
  if (guard.blocked) return guard.message;

  if (!process.env.ARBITRUM_RPC_URL) return "ARBITRUM_RPC_URL env var not set";

  const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
  const signer   = EVM_WALLET().connect(provider);

  // Market addresses (Arbitrum mainnet)
  const GMX_MARKETS = {
    "ETH":  "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",
    "BTC":  "0x47c031236e19d024b42f8AE6780E44A573170703",
    "SOL":  "0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9",
    "ARB":  "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407",
  };
  const marketAddr = GMX_MARKETS[market.toUpperCase()];
  if (!marketAddr) return `GMX market not found for ${market}. Available: ${Object.keys(GMX_MARKETS).join(", ")}`;

  const collateralAddr = TOKENS[collateralToken.toUpperCase()]?.["arbitrum"];
  if (!collateralAddr) return `Unknown collateral token: ${collateralToken}`;

  const isLong       = side.toLowerCase() === "buy" || side.toLowerCase() === "long";
  const executionFee = ethers.parseEther("0.0002"); // ~$0.50 execution fee to keepers

  const router = new ethers.Contract(GMX_ROUTER, GMX_ROUTER_ABI, signer);
  const tx = await router.createOrder(
    {
      receiver:                    signer.address,
      callbackContract:            ethers.ZeroAddress,
      uiFeeReceiver:               ethers.ZeroAddress,
      market:                      marketAddr,
      initialCollateralToken:      collateralAddr,
      swapPath:                    [],
      sizeDeltaUsd:                ethers.parseUnits(sizeUsd.toString(), 30), // GMX uses 30-decimal USD
      initialCollateralDeltaAmount: ethers.parseUnits((sizeUsd * 0.1).toString(), 6), // 10x leverage example
      triggerPrice:                ethers.parseUnits((triggerPrice || 0).toString(), 30),
      acceptablePrice:             isLong
                                     ? ethers.parseUnits(((triggerPrice||1e9)*1.005).toString(), 30)
                                     : ethers.parseUnits(((triggerPrice||0)*0.995).toString(), 30),
      executionFee,
      callbackGasLimit:            0n,
      minOutputAmount:             0n,
      isLong,
      shouldUnwrapNativeToken:     false,
    },
    { value: executionFee }
  );

  const receipt = await tx.wait();
  return [
    `GMX V2 order (Arbitrum)`,
    `  market    : ${market}-USD`,
    `  direction : ${isLong ? "LONG" : "SHORT"}`,
    `  size USD  : $${sizeUsd}`,
    `  collateral: ${collateralToken}`,
    `  tx hash   : ${receipt.hash}`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// Other DEXes — quick reference for future expansion
//
// Drift (Solana perps):   npm install @drift-labs/sdk
//   → Uses @solana/web3.js keypair, similar pattern to Hyperliquid
//
// Vertex (Arbitrum perps): npm install @vertex-protocol/client
//   → EVM signing, off-chain order book + on-chain settlement
//
// Synthetix Perps (Base): use ethers directly against PerpsV3Market contract
//   → https://docs.synthetix.io/v/synthetix-v3/for-developers
//
// Kwenta (OP/Base):       Built on Synthetix, same contracts
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Unified dispatcher ───────────────────────────────────────────────────────

export async function executeDexTool(name, input) {
  try {
    switch (name) {
      case "hl_get_account":      return await hlGetAccount();
      case "hl_get_market":       return await hlGetMarket(input);
      case "hl_place_perp":       return await hlPlacePerpOrder(input);
      case "hl_place_spot":       return await hlPlaceSpotOrder(input);
      case "uniswap_swap":        return await uniswapSwap(input);
      case "dydx_place_order":    return await dydxPlaceOrder(input);
      case "gmx_place_order":     return await gmxPlaceOrder(input);
      default: return `Unknown DEX tool: ${name}`;
    }
  } catch (err) {
    return `DEX tool error (${name}): ${err.message}`;
  }
}

// ─── Tool definitions for Claude API ─────────────────────────────────────────

export const DEX_TOOL_DEFS = [
  {
    name: "hl_get_account",
    description: "Get Hyperliquid account equity and open perpetual positions",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "hl_get_market",
    description: "Get Hyperliquid mark price, funding rate, and open interest for a perp market",
    input_schema: {
      type: "object",
      properties: { coin: { type: "string", description: "e.g. ETH, BTC, SOL" } },
      required: ["coin"],
    },
  },
  {
    name: "hl_place_perp",
    description: "Place a perpetual futures order on Hyperliquid. Max $100 USDT. Supports leverage.",
    input_schema: {
      type: "object",
      properties: {
        coin:       { type: "string", description: "e.g. ETH" },
        side:       { type: "string", enum: ["buy","sell"] },
        sz:         { type: "number", description: "Size in base coin" },
        limitPx:    { type: "number", description: "Limit/reference price" },
        leverage:   { type: "number", description: "Leverage multiplier (1-50)", default: 1 },
        reduceOnly: { type: "boolean", default: false },
      },
      required: ["coin","side","sz","limitPx"],
    },
  },
  {
    name: "hl_place_spot",
    description: "Place a spot order on Hyperliquid. Max $100 USDT.",
    input_schema: {
      type: "object",
      properties: {
        token:    { type: "string", description: "Token symbol e.g. ETH" },
        side:     { type: "string", enum: ["buy","sell"] },
        sz:       { type: "number" },
        limitPx:  { type: "number" },
      },
      required: ["token","side","sz","limitPx"],
    },
  },
  {
    name: "uniswap_swap",
    description: "Swap tokens on Uniswap V3 (Ethereum mainnet or Arbitrum). Max $100 input.",
    input_schema: {
      type: "object",
      properties: {
        tokenIn:   { type: "string", description: "e.g. USDC, USDT" },
        tokenOut:  { type: "string", description: "e.g. WETH, WBTC" },
        amountIn:  { type: "number", description: "Input amount in human units" },
        chain:     { type: "string", enum: ["mainnet","arbitrum"], default: "arbitrum" },
        feeTier:   { type: "number", enum: [500,3000,10000], default: 3000 },
      },
      required: ["tokenIn","tokenOut","amountIn"],
    },
  },
  {
    name: "dydx_place_order",
    description: "Place a perpetual order on dYdX V4 (gasless, Cosmos-based). Max $100.",
    input_schema: {
      type: "object",
      properties: {
        market:  { type: "string", description: "e.g. ETH, BTC, SOL" },
        side:    { type: "string", enum: ["buy","sell"] },
        size:    { type: "number" },
        price:   { type: "number" },
      },
      required: ["market","side","size","price"],
    },
  },
  {
    name: "gmx_place_order",
    description: "Open a long or short position on GMX V2 (Arbitrum). USD-denominated size. Max $100.",
    input_schema: {
      type: "object",
      properties: {
        market:          { type: "string", description: "ETH, BTC, SOL, or ARB" },
        side:            { type: "string", enum: ["long","short"] },
        sizeUsd:         { type: "number", description: "Position size in USD" },
        collateralToken: { type: "string", default: "USDC" },
        triggerPrice:    { type: "number", description: "0 for market order" },
      },
      required: ["market","side","sizeUsd"],
    },
  },
];
