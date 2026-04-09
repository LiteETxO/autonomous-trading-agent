/**
 * bybit-agent-tools.js
 * Bybit V5 API — tool handlers for the autonomous trading agent
 *
 * Setup:
 *   1. npm install crypto-js node-fetch   (or use built-in crypto + fetch in Node 18+)
 *   2. Set env vars:
 *        BYBIT_API_KEY=your_key
 *        BYBIT_API_SECRET=your_secret
 *        BYBIT_TESTNET=true    ← set to false only when ready for live trading
 */

import crypto from "crypto";
import fs     from "fs";

// Load .env
try {
  fs.readFileSync(".env", "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

// ─── Config ──────────────────────────────────────────────────────────────────

const TESTNET = process.env.BYBIT_TESTNET !== "false"; // defaults to testnet
const BASE_URL = TESTNET
  ? "https://api-testnet.bybit.com"
  : "https://api.bybit.com";

const API_KEY = process.env.BYBIT_API_KEY;
const API_SECRET = process.env.BYBIT_API_SECRET;

if (!API_KEY || !API_SECRET) {
  throw new Error(
    "Missing BYBIT_API_KEY or BYBIT_API_SECRET environment variables."
  );
}

// ─── Signing ─────────────────────────────────────────────────────────────────

/**
 * Build the HMAC-SHA256 signature Bybit requires on every authenticated call.
 * Signature = HMAC_SHA256(timestamp + apiKey + recvWindow + queryString/body)
 */
function sign(timestamp, recvWindow, payload) {
  const raw = `${timestamp}${API_KEY}${recvWindow}${payload}`;
  return crypto.createHmac("sha256", API_SECRET).update(raw).digest("hex");
}

function authHeaders(payload = "") {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const signature = sign(timestamp, recvWindow, payload);
  return {
    "Content-Type": "application/json",
    "X-BAPI-API-KEY": API_KEY,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": recvWindow,
    "X-BAPI-SIGN": signature,
  };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function get(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, { headers: authHeaders(qs) });
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);
  return data.result;
}

async function post(path, body = {}) {
  const bodyStr = JSON.stringify(body);
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(bodyStr),
    body: bodyStr,
  });
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Bybit error: ${data.retMsg}`);
  return data.result;
}

// ─── Tool: web_search ────────────────────────────────────────────────────────
// (unchanged — uses Claude's built-in web_search via the API)

// ─── Tool: analyze_chart ─────────────────────────────────────────────────────

/**
 * Fetch recent kline data from Bybit and compute SMA + RSI.
 *
 * @param {string} symbol  e.g. "ETHUSDT"
 * @param {string} interval  "D" = daily, "60" = 1h, "15" = 15m
 * @param {number} period  number of candles for SMA/RSI (default 14)
 */
export async function analyzeChart({ symbol, interval = "D", period = 14 }) {
  const result = await get("/v5/market/kline", {
    category: "spot",
    symbol: symbol.toUpperCase().replace("/", ""),
    interval,
    limit: period + 1,
  });

  // Bybit returns candles as [timestamp, open, high, low, close, volume, turnover]
  const closes = result.list.map((c) => parseFloat(c[4])).reverse();

  // SMA
  const sma = closes.reduce((a, b) => a + b, 0) / closes.length;

  // RSI (Wilder's method)
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / (closes.length - 1);
  const avgLoss = losses / (closes.length - 1);
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  const last = closes[closes.length - 1];
  const trend = last > sma ? "above SMA (bullish bias)" : "below SMA (bearish bias)";

  return [
    `${symbol} | interval: ${interval} | period: ${period}`,
    `Last close: $${last.toFixed(2)}`,
    `SMA(${period}): $${sma.toFixed(2)} — ${trend}`,
    `RSI(${period}): ${rsi.toFixed(1)}${rsi < 30 ? " ← oversold" : rsi > 70 ? " ← overbought" : ""}`,
  ].join("\n");
}

// ─── Tool: get_balance ───────────────────────────────────────────────────────

/**
 * Fetch UNIFIED wallet balance for a given coin.
 * @param {string} coin  e.g. "USDT"
 */
export async function getBalance({ coin = "USDT" }) {
  const result = await get("/v5/account/wallet-balance", {
    accountType: "UNIFIED",
  });
  const account = result.list?.[0];
  if (!account) return `No balance found.`;

  // totalEquity = USDT + all held assets valued in USDT (the true portfolio value)
  const totalEquity = parseFloat(account.totalEquity || account.totalWalletBalance || 0);

  // Also report individual coin balance if requested
  const info      = account.coin?.find((c) => c.coin === coin);
  const available = parseFloat(info?.availableToWithdraw || info?.availableBalance || info?.walletBalance || 0);
  const coinEquity = parseFloat(info?.equity || info?.walletBalance || 0);

  // List all non-zero holdings
  const holdings = (account.coin || [])
    .filter(c => parseFloat(c.walletBalance || 0) > 0)
    .map(c => `    ${c.coin}: ${parseFloat(c.walletBalance).toFixed(6)} (≈$${parseFloat(c.usdValue || 0).toFixed(2)})`)
    .join("\n");

  return [
    `Portfolio equity (all assets): $${totalEquity.toFixed(2)}`,
    `  Equity:    ${totalEquity.toFixed(4)}`,
    `${coin} balance`,
    `  Available: ${available.toFixed(4)}`,
    ...(holdings ? [`  Holdings:\n${holdings}`] : []),
  ].join("\n");
}

// ─── Tool: place_order ───────────────────────────────────────────────────────

/**
 * Place a spot market order on Bybit.
 *
 * @param {string} symbol   e.g. "ETHUSDT"
 * @param {string} side     "buy" | "sell"
 * @param {number} qty      quantity in base coin (e.g. 0.1 ETH)
 * @param {string} orderType  "Market" | "Limit"
 * @param {number} [price]  required if orderType = "Limit"
 */
const MAX_POSITION_USDT = 100;

export async function placeOrder({ symbol, side, qty, orderType = "Market", price }) {
  const sym = symbol.toUpperCase().replace("/", "");

  // ── Fetch live price (always needed for market orders) ───────────────────
  const ticker = await get("/v5/market/tickers", { category: "spot", symbol: sym });
  const lastPrice = parseFloat(ticker.list?.[0]?.lastPrice || "0");

  // ── Bybit V5 spot quirk ──────────────────────────────────────────────────
  // Market BUY  → qty must be in QUOTE currency (USDT)
  // Market SELL → qty must be in BASE currency (ETH/BTC/etc)
  // Limit orders → qty always in BASE currency
  // If the agent passes qty in base coin, convert BUY market orders to USDT.
  let orderQty = qty;
  let isQuoteQty = false;
  if (orderType === "Market" && side.toLowerCase() === "buy") {
    // If qty looks like base coin (< 10 for ETH, < 1 for BTC), convert to USDT
    const estimatedAsBase = qty * lastPrice;
    if (estimatedAsBase > 1) {
      // qty is in base coin → convert to USDT for market buy
      orderQty = +(qty * lastPrice).toFixed(2);
      isQuoteQty = true;
    }
    // Otherwise assume qty is already in USDT
  }

  // ── Position size guard ──────────────────────────────────────────────────
  const estimatedValue = isQuoteQty ? orderQty : (price ? qty * price : qty * lastPrice);
  if (estimatedValue > MAX_POSITION_USDT) {
    return [
      `Order REJECTED — position size guard`,
      `  Estimated value: $${estimatedValue.toFixed(2)}`,
      `  Max allowed:     $${MAX_POSITION_USDT}`,
      `  Tip: reduce qty`,
    ].join("\n");
  }
  // ────────────────────────────────────────────────────────────────────────

  const body = {
    category: "spot",
    symbol: sym,
    side: side.charAt(0).toUpperCase() + side.slice(1).toLowerCase(),
    orderType,
    ...(isQuoteQty
      ? { marketUnit: "quoteCoin", qty: orderQty.toString() }  // BUY market → USDT
      : { qty: orderQty.toString() }),                          // SELL/Limit → base coin
    ...(orderType === "Limit" && price ? { price: price.toString() } : {}),
    timeInForce: orderType === "Limit" ? "GTC" : "IOC",
  };

  const result = await post("/v5/order/create", body);

  return [
    `Order placed ${TESTNET ? "(TESTNET)" : "(LIVE)"}`,
    `  orderId:   ${result.orderId}`,
    `  symbol:    ${body.symbol}`,
    `  side:      ${body.side}`,
    `  qty:       ${isQuoteQty ? orderQty + " USDT" : orderQty + " " + sym.replace("USDT","")}`,
    `  ~value:    $${estimatedValue.toFixed(2)}`,
    `  type:      ${body.orderType}`,
    ...(price ? [`  price:     $${price}`] : []),
  ].join("\n");
}

// ─── Tool: get_ticker ────────────────────────────────────────────────────────

/**
 * Get current best bid/ask and 24h stats for a symbol.
 */
export async function getTicker({ symbol }) {
  const result = await get("/v5/market/tickers", {
    category: "spot",
    symbol: symbol.toUpperCase().replace("/", ""),
  });
  const t = result.list?.[0];
  if (!t) return `No ticker found for ${symbol}`;
  return [
    `${symbol} ticker`,
    `  Last:     $${parseFloat(t.lastPrice).toFixed(2)}`,
    `  Bid/Ask:  $${parseFloat(t.bid1Price).toFixed(2)} / $${parseFloat(t.ask1Price).toFixed(2)}`,
    `  24h chg:  ${parseFloat(t.price24hPcnt * 100).toFixed(2)}%`,
    `  24h vol:  ${parseFloat(t.volume24h).toLocaleString()} ${symbol.replace("USDT","")}`,
  ].join("\n");
}

// ─── Tool dispatcher (drop this into your agent loop) ────────────────────────

/**
 * Replace the `executeTool` function in your agent with this.
 * The Claude API tool_use block gives you { name, input } — pass them here.
 */
export async function executeTool(name, input) {
  try {
    switch (name) {
      case "analyze_chart":     return await analyzeChart(input);
      case "get_balance":       return await getBalance(input);
      case "place_order":       return await placeOrder(input);
      case "get_ticker":        return await getTicker(input);
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error (${name}): ${err.message}`;
  }
}

// ─── Tool definitions for the Claude API ─────────────────────────────────────
// Pass this array as the `tools` field in your /v1/messages request.

export const BYBIT_TOOL_DEFS = [
  {
    name: "get_ticker",
    description: "Get current price, bid/ask spread and 24h stats for a Bybit spot pair",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. ETHUSDT" } },
      required: ["symbol"],
    },
  },
  {
    name: "analyze_chart",
    description: "Fetch recent OHLCV candles from Bybit and compute SMA + RSI",
    input_schema: {
      type: "object",
      properties: {
        symbol:   { type: "string", description: "e.g. ETHUSDT" },
        interval: { type: "string", description: "D=daily, 60=1h, 15=15m", default: "D" },
        period:   { type: "number", description: "Candle count for SMA/RSI", default: 14 },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_balance",
    description: "Check available wallet balance for a coin in the Bybit UNIFIED account",
    input_schema: {
      type: "object",
      properties: { coin: { type: "string", description: "e.g. USDT, ETH, BTC" } },
      required: ["coin"],
    },
  },
  {
    name: "place_order",
    description: "Place a spot buy or sell order on Bybit. Max position size is $100 USDT — orders exceeding this are automatically rejected.",
    input_schema: {
      type: "object",
      properties: {
        symbol:    { type: "string", description: "e.g. ETHUSDT" },
        side:      { type: "string", enum: ["buy", "sell"] },
        qty:       { type: "number", description: "Quantity in base coin" },
        orderType: { type: "string", enum: ["Market", "Limit"], default: "Market" },
        price:     { type: "number", description: "Required for Limit orders" },
      },
      required: ["symbol", "side", "qty"],
    },
  },
];
