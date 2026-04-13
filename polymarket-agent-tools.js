/**
 * polymarket-agent-tools.js
 * Polymarket prediction market tools for the autonomous trading agent.
 *
 * Reads market data from mainnet Gamma API (no auth).
 * Places orders via staging CLOB (Amoy testnet).
 *
 * Wallet: 0xc3c4D00e824088B43938FD8172e82F5eCe776761 (Amoy testnet)
 * Fund at: https://faucet.polygon.technology/ (test MATIC)
 * Test USDC faucet: https://faucet.circle.com/ (select Amoy)
 */

import { ClobClient, Chain, Side, OrderType } from "@polymarket/clob-client";
import { ethers } from "./node_modules/ethers/lib.esm/index.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const POLY_TESTNET = process.env.POLY_TESTNET !== "false"; // default: true
const CLOB_HOST = POLY_TESTNET
  ? "https://clob-staging.polymarket.com"
  : "https://clob.polymarket.com";
const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CHAIN     = POLY_TESTNET ? Chain.AMOY : Chain.POLYGON;

// Minimum order size on CLOB (USDC)
const MIN_ORDER_USDC = 15;

// ─── Client singleton ─────────────────────────────────────────────────────────

let _client = null;
let _wallet = null;

function getWallet() {
  if (_wallet) return _wallet;
  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk || pk.startsWith("0x...") || pk.length < 32) return null;
  _wallet = new ethers.Wallet(pk);
  return _wallet;
}

async function getClient() {
  if (_client) return _client;
  const wallet = getWallet();
  if (!wallet) {
    // Read-only client (no signer) — market data only
    _client = new ClobClient(CLOB_HOST, CHAIN);
    return _client;
  }
  const signer = {
    address:          wallet.address,
    getAddress:       () => Promise.resolve(wallet.address),
    signMessage:      (msg) => wallet.signMessage(msg),
    _signTypedData:   (domain, types, value) => wallet.signTypedData(domain, types, value),
  };
  // Step 1: derive API key (L1 auth)
  const bootstrap = new ClobClient(CLOB_HOST, CHAIN, signer);
  const creds = await bootstrap.createOrDeriveApiKey();
  // Step 2: authenticated client (L2 auth)
  _client = new ClobClient(CLOB_HOST, CHAIN, signer, creds);
  console.log("[polymarket] Client ready, address:", wallet.address);
  return _client;
}

// ─── Helper: parse clobTokenIds ───────────────────────────────────────────────

function parseTokenIds(market) {
  try {
    if (Array.isArray(market.clobTokenIds)) return market.clobTokenIds;
    if (typeof market.clobTokenIds === "string") return JSON.parse(market.clobTokenIds);
    if (Array.isArray(market.tokens)) return market.tokens;
  } catch {}
  return [];
}

// ─── Tool: polymarket_search_markets ─────────────────────────────────────────

async function searchMarkets({ query = "bitcoin", limit = 8, min_volume = 1000 }) {
  try {
    const params = new URLSearchParams({
      limit: String(Math.min(limit * 3, 30)),
      active: "true",
      closed: "false",
      _q: query,
    });
    const res  = await fetch(`${GAMMA_HOST}/markets?${params}`);
    const data = await res.json();
    const list = (Array.isArray(data) ? data : (data.markets || []));

    const filtered = list
      .filter(m => !m.closed && m.active && m.acceptingOrders !== false)
      .filter(m => (m.volumeNum || m.volume24hrClob || 0) >= min_volume)
      .sort((a, b) => (b.volume24hrClob || b.volume24hr || 0) - (a.volume24hrClob || a.volume24hr || 0))
      .slice(0, limit);

    if (!filtered.length) return `No active markets found for "${query}" (min vol $${min_volume}).`;

    return filtered.map(m => {
      const tokens   = parseTokenIds(m);
      const outcomes = Array.isArray(m.outcomes) ? m.outcomes : ["Yes", "No"];
      const prices   = Array.isArray(m.outcomePrices) ? m.outcomePrices : [m.bestAsk || "?", "?"];
      const vol24h   = (m.volume24hrClob || m.volume24hr || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
      const deadline = m.endDateIso || m.endDate || "?";
      const yesPrice = parseFloat(prices[0] || 0.5).toFixed(3);
      const noPrice  = parseFloat(prices[1] || 0.5).toFixed(3);
      const spread   = ((parseFloat(m.bestAsk || yesPrice) - parseFloat(m.bestBid || yesPrice)) * 100).toFixed(1);

      return (
        `📋 ${m.question}\n` +
        `   condition_id: ${m.conditionId || m.id}\n` +
        `   yes_token: ${tokens[0] || "n/a"}\n` +
        `   no_token:  ${tokens[1] || "n/a"}\n` +
        `   YES: $${yesPrice} | NO: $${noPrice} | spread: ${spread}%\n` +
        `   vol24h: $${vol24h} | resolves: ${deadline.split("T")[0]}`
      );
    }).join("\n\n");
  } catch (e) {
    return `ERROR searching Polymarket: ${e.message}`;
  }
}

// ─── Tool: polymarket_get_price ───────────────────────────────────────────────

async function getPrice({ condition_id }) {
  try {
    const res  = await fetch(`${GAMMA_HOST}/markets?_q=${condition_id}&limit=1`);
    const data = await res.json();
    const mkt  = (Array.isArray(data) ? data : (data.markets || []))[0];

    if (!mkt) {
      // Try CLOB midpoints for individual token
      const client = await getClient();
      try {
        const mid = await client.getMidpoint(condition_id);
        return `Midpoint for token ${condition_id.slice(0, 12)}...: ${JSON.stringify(mid)}`;
      } catch {}
      return `Market not found for condition_id: ${condition_id}`;
    }

    const tokens   = parseTokenIds(mkt);
    const outcomes = Array.isArray(mkt.outcomes) ? mkt.outcomes : ["Yes", "No"];
    const prices   = Array.isArray(mkt.outcomePrices) ? mkt.outcomePrices : [mkt.lastTradePrice || "?", "?"];

    // Implied probability = current price (0–1 scale)
    const yesProb = (parseFloat(prices[0] || 0) * 100).toFixed(1);
    const noProb  = (parseFloat(prices[1] || 0) * 100).toFixed(1);

    return (
      `${mkt.question}\n` +
      `YES (${outcomes[0]}): $${parseFloat(prices[0]).toFixed(4)} = ${yesProb}% implied prob\n` +
      `NO  (${outcomes[1]}): $${parseFloat(prices[1]).toFixed(4)} = ${noProb}% implied prob\n` +
      `Best bid: $${mkt.bestBid || "?"} | Best ask: $${mkt.bestAsk || "?"}\n` +
      `24h volume: $${(mkt.volume24hrClob || mkt.volume24hr || 0).toLocaleString()}\n` +
      `Resolves: ${(mkt.endDateIso || mkt.endDate || "?").split("T")[0]}\n` +
      `YES token: ${tokens[0] || "n/a"}\n` +
      `NO  token: ${tokens[1] || "n/a"}`
    );
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// ─── Tool: polymarket_place_order ─────────────────────────────────────────────

async function placeOrder({ token_id, side, size_usdc, price }) {
  const wallet = getWallet();
  if (!wallet) {
    return (
      "ERROR: WALLET_PRIVATE_KEY not configured.\n" +
      "Set WALLET_PRIVATE_KEY in .env with the testnet wallet private key.\n" +
      "Fund wallet 0xc3c4D00e824088B43938FD8172e82F5eCe776761 with:\n" +
      "  - Test MATIC: https://faucet.polygon.technology/ (select Amoy)\n" +
      "  - Test USDC:  https://faucet.circle.com/ (select Amoy)"
    );
  }

  if (size_usdc < MIN_ORDER_USDC) {
    return `ERROR: Minimum order size is $${MIN_ORDER_USDC} USDC. Requested: $${size_usdc}`;
  }

  const orderSide = (side || "BUY").toUpperCase() === "BUY" ? Side.BUY : Side.SELL;
  const limitPrice = parseFloat(price);

  if (isNaN(limitPrice) || limitPrice <= 0 || limitPrice >= 1) {
    return `ERROR: price must be between 0 and 1 (e.g. 0.65 = 65¢ per share). Got: ${price}`;
  }

  try {
    const client   = await getClient();
    const tickSize = await client.getTickSize(token_id).catch(() => 0.01);

    const orderArgs = {
      tokenID:   token_id,
      price:     limitPrice,
      side:      orderSide,
      size:      size_usdc / limitPrice,  // size in shares = USDC / price
      feeRateBps: 0,
    };

    const signedOrder = await client.createOrder(orderArgs);
    const resp        = await client.postOrder(signedOrder, OrderType.GTC);

    if (resp?.errorMsg || resp?.error) {
      return `Order REJECTED: ${resp.errorMsg || JSON.stringify(resp)}`;
    }

    const orderId = resp?.orderID || resp?.id || JSON.stringify(resp).slice(0, 80);
    const shares  = (size_usdc / limitPrice).toFixed(2);

    return (
      `ORDER PLACED ✓\n` +
      `  Side:    ${orderSide === Side.BUY ? "BUY (YES)" : "SELL (YES = go NO)"}\n` +
      `  Token:   ${token_id.slice(0, 16)}...\n` +
      `  Price:   $${limitPrice} per share\n` +
      `  Shares:  ${shares}\n` +
      `  Cost:    ~$${size_usdc} USDC\n` +
      `  Order ID: ${orderId}\n` +
      `  Network: ${POLY_TESTNET ? "Amoy testnet" : "Polygon mainnet"}`
    );
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.includes("allowance") || msg.includes("insufficient")) {
      return (
        `ORDER FAILED — Insufficient USDC allowance or balance.\n` +
        `Wallet: ${wallet.address}\n` +
        `You need test USDC on Amoy testnet:\n` +
        `  1. Get test MATIC: https://faucet.polygon.technology/\n` +
        `  2. Get test USDC:  https://faucet.circle.com/ (Amoy network)\n` +
        `  3. Approve CTF Exchange to spend USDC on Amoy\n` +
        `Error detail: ${msg.slice(0, 200)}`
      );
    }
    return `ORDER FAILED: ${msg.slice(0, 300)}`;
  }
}

// ─── Tool: polymarket_get_open_orders ─────────────────────────────────────────

async function getOpenOrders({ market = "" } = {}) {
  const wallet = getWallet();
  if (!wallet) return "ERROR: WALLET_PRIVATE_KEY not configured";
  try {
    const client = await getClient();
    const orders = await client.getOpenOrders(market ? { market } : {});
    const list   = Array.isArray(orders) ? orders : (orders?.data || []);

    if (!list.length) return "No open Polymarket orders.";

    return "Open Polymarket Orders:\n" + list.map(o => {
      const side    = o.side === 0 || o.side === "BUY" ? "BUY (YES)" : "SELL";
      const filled  = parseFloat(o.sizeMatched || 0).toFixed(2);
      const total   = parseFloat(o.size || o.originalSize || 0).toFixed(2);
      return (
        `  [${o.id || o.orderID}]\n` +
        `    Side: ${side} | Price: $${o.price} | Size: ${total} shares\n` +
        `    Filled: ${filled} / ${total} | Status: ${o.status || "OPEN"}\n` +
        `    Token: ${(o.asset_id || o.tokenId || "").slice(0, 20)}...`
      );
    }).join("\n\n");
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// ─── Tool: polymarket_cancel_order ────────────────────────────────────────────

async function cancelOrder({ order_id }) {
  const wallet = getWallet();
  if (!wallet) return "ERROR: WALLET_PRIVATE_KEY not configured";
  try {
    const client = await getClient();
    const resp   = await client.cancelOrder({ orderID: order_id });
    if (resp?.errorMsg) return `Cancel FAILED: ${resp.errorMsg}`;
    return `Order ${order_id} cancelled successfully.`;
  } catch (e) {
    return `ERROR cancelling order: ${e.message}`;
  }
}

// ─── Tool: polymarket_get_trades ──────────────────────────────────────────────

async function getTrades({ limit = 10 } = {}) {
  const wallet = getWallet();
  if (!wallet) return "ERROR: WALLET_PRIVATE_KEY not configured";
  try {
    const client = await getClient();
    const trades = await client.getTrades({ maker: wallet.address });
    const list   = Array.isArray(trades) ? trades : (trades?.data || []);

    if (!list.length) return "No Polymarket trades found for this wallet.";

    return "Recent Polymarket Trades:\n" + list.slice(0, limit).map(t => {
      const side = t.side === 0 || t.side === "BUY" ? "BUY" : "SELL";
      const pnl  = t.outcome ? ` | outcome: ${t.outcome}` : "";
      return (
        `  [${(t.id || "").slice(0, 12)}] ${side} ${t.size} @ $${t.price}` +
        `  | $${(parseFloat(t.size) * parseFloat(t.price)).toFixed(2)} USDC${pnl}`
      );
    }).join("\n");
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

export const POLYMARKET_TOOL_DEFS = [
  {
    name: "polymarket_search_markets",
    description:
      "Search Polymarket prediction markets by keyword. Returns active markets with YES/NO prices, token IDs, volume, and resolution date. " +
      "Use to find crypto/macro markets where you have a strong directional view. " +
      "Good queries: 'bitcoin 100k', 'ethereum', 'btc price', 'fed rate', 'us recession'. " +
      "YES price = implied probability (e.g. $0.65 = 65% chance YES resolves). " +
      "If your analysis strongly disagrees with the market price, there is edge to trade.",
    input_schema: {
      type: "object",
      properties: {
        query:      { type: "string",  description: "Search keyword (e.g. 'bitcoin 100k', 'ethereum etf', 'fed rate cut')" },
        limit:      { type: "number",  description: "Number of markets to return (default 6, max 15)" },
        min_volume: { type: "number",  description: "Minimum 24h volume in USD to filter illiquid markets (default 1000)" },
      },
      required: ["query"],
    },
  },
  {
    name: "polymarket_get_price",
    description:
      "Get current YES/NO prices and implied probabilities for a specific Polymarket market. " +
      "Pass the condition_id from polymarket_search_markets. " +
      "Returns price, implied probability, bid/ask, volume, and YES/NO token IDs. " +
      "Use to confirm current pricing before placing an order.",
    input_schema: {
      type: "object",
      properties: {
        condition_id: { type: "string", description: "Market condition_id from polymarket_search_markets" },
      },
      required: ["condition_id"],
    },
  },
  {
    name: "polymarket_place_order",
    description:
      "Place a limit order on a Polymarket prediction market. " +
      "BUY = you believe outcome is more likely than market price suggests. " +
      "SELL = you believe outcome is less likely than market price suggests. " +
      "Example: if YES is $0.40 but you think it's 60% likely, BUY YES token at $0.42. " +
      "Minimum order: $15 USDC. Price must be between 0.01 and 0.99. " +
      "Use yes_token or no_token from polymarket_search_markets as the token_id.",
    input_schema: {
      type: "object",
      properties: {
        token_id:   { type: "string",  description: "ERC-1155 token ID from polymarket_search_markets (yes_token or no_token)" },
        side:       { type: "string",  description: "'BUY' to go long or 'SELL' to go short on this outcome" },
        size_usdc:  { type: "number",  description: "Order size in USDC (minimum $15)" },
        price:      { type: "number",  description: "Limit price per share, 0.01–0.99 (e.g. 0.65 = 65¢)" },
      },
      required: ["token_id", "side", "size_usdc", "price"],
    },
  },
  {
    name: "polymarket_get_open_orders",
    description:
      "List all open (unfilled) Polymarket prediction market orders for this wallet. " +
      "Shows order ID, side, price, size, and fill status. Use to manage positions.",
    input_schema: {
      type: "object",
      properties: {
        market: { type: "string", description: "Optional: filter by market condition_id" },
      },
      required: [],
    },
  },
  {
    name: "polymarket_cancel_order",
    description: "Cancel an open Polymarket order by order ID. Retrieve order IDs from polymarket_get_open_orders.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Order ID to cancel" },
      },
      required: ["order_id"],
    },
  },
  {
    name: "polymarket_get_trades",
    description: "Get recent Polymarket trade history for this wallet. Shows fills, prices, and outcomes.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of trades to return (default 10)" },
      },
      required: [],
    },
  },
];

export async function executePolyTool(name, input) {
  switch (name) {
    case "polymarket_search_markets":  return searchMarkets(input);
    case "polymarket_get_price":       return getPrice(input);
    case "polymarket_place_order":     return placeOrder(input);
    case "polymarket_get_open_orders": return getOpenOrders(input);
    case "polymarket_cancel_order":    return cancelOrder(input);
    case "polymarket_get_trades":      return getTrades(input);
    default: return `Unknown Polymarket tool: ${name}`;
  }
}
