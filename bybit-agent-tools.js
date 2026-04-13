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

const TESTNET  = process.env.BYBIT_TESTNET !== "false"; // defaults to testnet
const BASE_URL = TESTNET
  ? "https://api-testnet.bybit.com"
  : "https://api.bybit.com";

// Always use mainnet for public market data — testnet prices are stale/fake
const MARKET_URL = "https://api.bybit.com";

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

// Public market data — always mainnet, no auth needed
async function getMarket(path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `${MARKET_URL}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url);
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
 * @param {string} category  "spot" | "linear" (default: spot)
 */
export async function analyzeChart({ symbol, interval = "D", period = 14, category = "spot" }) {
  const result = await getMarket("/v5/market/kline", {
    category,
    symbol: symbol.toUpperCase().replace("/", ""),
    interval,
    limit: period + 1,
  });

  if (!result.list || result.list.length < 2) {
    return `${symbol} | No data available (symbol may not be supported)`;
  }

  // Bybit returns candles as [timestamp, open, high, low, close, volume, turnover]
  const closes  = result.list.map((c) => parseFloat(c[4])).reverse();
  const volumes = result.list.map((c) => parseFloat(c[5])).reverse();

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

  // Volume: compare last candle to prior average
  const priorAvgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
  const lastVol     = volumes[volumes.length - 1];
  const volRatio    = priorAvgVol > 0 ? lastVol / priorAvgVol : 1;
  const volNote     = volRatio >= 1.5 ? `SPIKE ${volRatio.toFixed(1)}x avg ↑`
                    : volRatio <= 0.6 ? `LOW ${volRatio.toFixed(1)}x avg ↓`
                    : `normal ${volRatio.toFixed(1)}x avg`;

  const last = closes[closes.length - 1];
  const trend = last > sma ? "above SMA (bullish bias)" : "below SMA (bearish bias)";

  // Stop precision check — warn if 3% stop can't be represented at 2dp
  const stopAt2dp = +(last * 0.97).toFixed(2);
  const stopNote  = stopAt2dp === +last.toFixed(2) ? "  ⚠ STOP PRECISION ISSUE — 3% stop rounds to entry price, skip this symbol" : "";

  return [
    `${symbol} | interval: ${interval} | period: ${period}`,
    `Last close: $${last.toFixed(2)}`,
    `SMA(${period}): $${sma.toFixed(2)} — ${trend}`,
    `RSI(${period}): ${rsi.toFixed(1)}${rsi < 30 ? " ← oversold" : rsi > 70 ? " ← overbought" : ""}`,
    `Volume:  ${volNote}`,
    ...(stopNote ? [stopNote] : []),
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
const MAX_POSITION_USDT = 5000;

export async function placeOrder({ symbol, side, qty, orderType = "Market", price }) {
  const sym = symbol.toUpperCase().replace("/", "");

  // ── Fetch live price (always needed for market orders) ───────────────────
  const ticker = await getMarket("/v5/market/tickers", { category: "spot", symbol: sym });
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

// ─── Tool: place_perp_order ──────────────────────────────────────────────────

const MAX_LEVERAGE    = 3;   // hard cap — never allow >3x
const DEFAULT_LEVERAGE = 2;

async function setPerpLeverage(sym, leverage) {
  try {
    await post("/v5/position/set-leverage", {
      category: "linear", symbol: sym,
      buyLeverage:  leverage.toString(),
      sellLeverage: leverage.toString(),
    });
  } catch (e) {
    // "leverage not modified" (retCode 110043) = already at requested value — fine
    // "ab not enough for new leverage" = insufficient margin to init leverage — try lev=1
    const msg = e.message.toLowerCase();
    if (msg.includes("leverage not modified") || msg.includes("110043")) return; // already set, proceed
    if (msg.includes("ab not enough for new leverage")) {
      // try with isolated margin at 1x as fallback
      try {
        await post("/v5/position/set-leverage", {
          category: "linear", symbol: sym,
          buyLeverage: "1", sellLeverage: "1",
        });
      } catch (e2) {
        const m2 = e2.message.toLowerCase();
        if (!m2.includes("leverage not modified") && !m2.includes("110043")) throw e2;
      }
      return;
    }
    throw e;
  }
}

/**
 * Open a linear (USDT-margined) perp position.
 * side="Buy" = long perp, side="Sell" = short perp
 */
export async function placePerpOrder({ symbol, side, qty, leverage = DEFAULT_LEVERAGE, orderType = "Market", price }) {
  const sym = symbol.toUpperCase().replace("/", "");
  const lev = Math.min(Math.max(1, Math.round(leverage)), MAX_LEVERAGE);
  const buySell = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();

  // 1. Set leverage
  await setPerpLeverage(sym, lev);

  // 2. Current price for value estimate
  const ticker = await getMarket("/v5/market/tickers", { category: "linear", symbol: sym });
  const lastPrice = parseFloat(ticker.list?.[0]?.lastPrice || "0");

  // 3. Guard: notional > MAX_POSITION_USDT
  const notionalUsd = qty * lastPrice;
  if (notionalUsd > MAX_POSITION_USDT) {
    return `Perp order REJECTED — notional $${notionalUsd.toFixed(0)} exceeds max $${MAX_POSITION_USDT}`;
  }

  // 4. Place order
  const body = {
    category:    "linear",
    symbol:      sym,
    side:        buySell,
    orderType,
    qty:         qty.toString(),
    timeInForce: orderType === "Limit" ? "GTC" : "IOC",
    positionIdx: 0,   // one-way mode
    ...(orderType === "Limit" && price ? { price: price.toString() } : {}),
  };
  const result = await post("/v5/order/create", body);
  const direction = buySell === "Buy" ? "LONG" : "SHORT";
  const marginUsed = (notionalUsd / lev).toFixed(2);

  return [
    `Perp order placed ${TESTNET ? "(TESTNET)" : "(LIVE)"}`,
    `  orderId:   ${result.orderId}`,
    `  symbol:    ${sym} (linear perp)`,
    `  direction: ${direction}`,
    `  qty:       ${qty} ${sym.replace("USDT","")}`,
    `  notional:  ~$${notionalUsd.toFixed(2)}`,
    `  margin:    ~$${marginUsed} (${lev}x)`,
    `  type:      ${orderType}`,
  ].join("\n");
}

/**
 * Close an existing perp position (reduceOnly market order).
 * Closing a long → Sell reduceOnly. Closing a short → Buy reduceOnly.
 */
export async function closePerpPosition({ symbol, side, qty }) {
  const sym      = symbol.toUpperCase().replace("/", "");
  const isLong   = ["long","buy","Buy","Long"].includes(side);
  const closeSide = isLong ? "Sell" : "Buy";
  const body = {
    category:    "linear",
    symbol:      sym,
    side:        closeSide,
    orderType:   "Market",
    qty:         qty.toString(),
    timeInForce: "IOC",
    reduceOnly:  true,
    positionIdx: 0,
  };
  const result = await post("/v5/order/create", body);
  return `Perp position closed | orderId: ${result.orderId} | ${sym} ${closeSide} qty=${qty} (reduceOnly)`;
}

// ─── Tool: get_ticker ────────────────────────────────────────────────────────

/**
 * Get current best bid/ask and 24h stats for a symbol.
 */
export async function getTicker({ symbol }) {
  const sym = symbol.toUpperCase().replace("/", "");

  // Fetch spot price data and linear (perp) funding rate in parallel
  const [spotResult, perpResult] = await Promise.all([
    getMarket("/v5/market/tickers", { category: "spot",   symbol: sym }),
    getMarket("/v5/market/tickers", { category: "linear", symbol: sym }),
  ]);

  const t = spotResult.list?.[0];
  if (!t) return `No ticker found for ${symbol}`;

  const perp          = perpResult.list?.[0];
  const fundingRate   = perp ? parseFloat(perp.fundingRate || 0) : 0;
  const fundingPct    = (fundingRate * 100).toFixed(4);
  const fundingLabel  = fundingRate > 0.02  ? " ⚠ HIGH (crowded long)"
                      : fundingRate < -0.01 ? " ✅ NEGATIVE (longs paid)"
                      : " neutral";

  return [
    `${symbol} ticker`,
    `  Last:     $${parseFloat(t.lastPrice).toFixed(2)}`,
    `  Bid/Ask:  $${parseFloat(t.bid1Price).toFixed(2)} / $${parseFloat(t.ask1Price).toFixed(2)}`,
    `  24h chg:  ${parseFloat(t.price24hPcnt * 100).toFixed(2)}%`,
    `  24h vol:  ${parseFloat(t.volume24h).toLocaleString()} ${symbol.replace("USDT","")}`,
    `  Funding:  ${fundingPct}%/8h${fundingLabel}`,
  ].join("\n");
}

// ─── Tool dispatcher (drop this into your agent loop) ────────────────────────

/**
 * Replace the `executeTool` function in your agent with this.
 * The Claude API tool_use block gives you { name, input } — pass them here.
 */
export async function getOpenPositions() {
  try {
    const raw  = fs.readFileSync("./data/open-positions.json", "utf8");
    const data = JSON.parse(raw);
    const open = (data.positions || []).filter(p => p.status === "open");
    if (!open.length) return "No open positions.";
    return open.map(p =>
      `OPEN | ${p.venue.toUpperCase()} ${p.symbol} ${p.side.toUpperCase()} | ` +
      `entry: $${p.entryPrice} | size: $${p.sizeUsd} | ` +
      `stop: $${p.stopPrice} | tp: $${p.tpPrice} | ` +
      `opened: ${new Date(p.openedAt).toISOString()}`
    ).join("\n");
  } catch {
    return "No open positions.";
  }
}


// ─── Tier 1 funding classifier (deterministic — no LLM judgment) ──────────────
// Takes tickers collected by the LLM and applies hard thresholds to select
// the mandatory 6-LONG + 6-SHORT candidates for Tier 2 deep analysis.
function tier1Screen({ tickers = [] }) {
  const LONG_STRONG    = -0.0003;  // < -0.03%/8h
  const LONG_ELIGIBLE  = -0.0001;  // -0.03% to -0.01%
  const SHORT_ELIGIBLE =  0.0001;  //  0.01% to 0.03%
  const SHORT_STRONG   =  0.0003;  // > +0.03%/8h

  const classify = (r) => {
    if (r < LONG_STRONG)    return "LONG-STRONG";
    if (r < LONG_ELIGIBLE)  return "LONG-ELIGIBLE";
    if (r > SHORT_STRONG)   return "SHORT-STRONG";
    if (r > SHORT_ELIGIBLE) return "SHORT-ELIGIBLE";
    return "NEUTRAL";
  };

  const rows = tickers.map(({ symbol, fundingRate }) => {
    const r   = parseFloat(fundingRate);
    const cat = classify(r);
    return { symbol, fundingRate: r, fundingPct: (r * 100).toFixed(4) + "%/8h", category: cat };
  });

  // Sort helpers
  const longRows  = rows.filter(r => r.category === "LONG-STRONG" || r.category === "LONG-ELIGIBLE")
                        .sort((a, b) => a.fundingRate - b.fundingRate);   // most negative first
  const shortRows = rows.filter(r => r.category === "SHORT-STRONG" || r.category === "SHORT-ELIGIBLE")
                        .sort((a, b) => b.fundingRate - a.fundingRate);  // most positive first
  const neutral   = rows.filter(r => r.category === "NEUTRAL");

  const longCandidates  = longRows.slice(0, 6);
  const shortCandidates = shortRows.slice(0, 6);

  // If either side has < 3, fill from neutral sorted by absolute rate
  const fill = (arr, target, side) => {
    if (arr.length < 3) {
      const extras = neutral.sort((a, b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate));
      for (const e of extras) {
        if (arr.length >= target) break;
        if (!arr.find(x => x.symbol === e.symbol)) arr.push({ ...e, category: `NEUTRAL->${side}` });
      }
    }
    return arr;
  };
  fill(longCandidates,  6, "LONG");
  fill(shortCandidates, 6, "SHORT");

  const summary = [
    `TIER 1 SCREEN RESULTS — ${rows.length} symbols classified`,
    ``,
    `LONG candidates (${longCandidates.length}): proceed with LONG direction in Tier 2`,
    ...longCandidates.map(r => `  ${r.symbol.padEnd(12)} ${r.fundingPct.padStart(14)}  [${r.category}]`),
    ``,
    `SHORT candidates (${shortCandidates.length}): proceed with SHORT direction in Tier 2`,
    ...shortCandidates.map(r => `  ${r.symbol.padEnd(12)} ${r.fundingPct.padStart(14)}  [${r.category}]`),
    ``,
    `NEUTRAL (${neutral.length} symbols, skipped): ${neutral.map(r => r.symbol).join(", ")}`,
    ``,
    `INSTRUCTION: Run Tier 2 deep analysis on ALL candidates above. ` +
    `Score each as LONG or SHORT per their assigned direction. ` +
    `Trade any with score >= 45.`,
  ].join("\n");

  return summary;
}

export async function executeTool(name, input) {
  try {
    switch (name) {
      case "analyze_chart":        return await analyzeChart(input);
      case "get_balance":          return await getBalance(input);
      case "place_order":          return await placeOrder(input);
      case "place_perp_order":     return await placePerpOrder(input);
      case "close_perp_position":  return await closePerpPosition(input);
      case "get_ticker":           return await getTicker(input);
      case "get_open_positions":   return await getOpenPositions();
      case "tier1_screen":         return tier1Screen(input);
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
    name: "get_open_positions",
    description: "Returns all currently open positions tracked by the agent. ALWAYS call this first before considering any new trade.",
    input_schema: { type: "object", properties: {} },
  },
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
    description: "Place a SPOT buy or sell order on Bybit (no leverage, long-only). Use place_perp_order for shorts or leveraged positions.",
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
  {
    name: "place_perp_order",
    description: "Open a USDT-margined linear perpetual position on Bybit. side=Buy = LONG perp, side=Sell = SHORT perp. Leverage capped at 3x (default 2x). qty is in base coin (e.g. 0.5 ETH). Max notional $5000.",
    input_schema: {
      type: "object",
      properties: {
        symbol:    { type: "string", description: "e.g. ETHUSDT" },
        side:      { type: "string", enum: ["Buy", "Sell"], description: "Buy=long, Sell=short" },
        qty:       { type: "number", description: "Base coin qty (notional/price). E.g. $1500 ETH at $2200 = 0.68" },
        leverage:  { type: "number", description: "Leverage multiplier 1-3 (default 2)", default: 2 },
        orderType: { type: "string", enum: ["Market", "Limit"], default: "Market" },
        price:     { type: "number", description: "Required for Limit orders" },
      },
      required: ["symbol", "side", "qty"],
    },
  },
  {
    name: "tier1_screen",
    description: "Classify funding rates and select mandatory Tier 2 candidates (6 LONG + 6 SHORT). Call this ONCE after collecting all 35 ticker funding rates. Pass the full array of {symbol, fundingRate} objects. Returns a pre-classified selection with exact symbols and directions — follow it exactly for Tier 2.",
    input_schema: {
      type: "object",
      properties: {
        tickers: {
          type: "array",
          description: "Array of {symbol, fundingRate} where fundingRate is raw decimal (e.g. 0.0003 = 0.03%/8h, -0.00095 = -0.095%/8h)",
          items: {
            type: "object",
            properties: {
              symbol:      { type: "string" },
              fundingRate: { type: "number" },
            },
            required: ["symbol", "fundingRate"],
          },
        },
      },
      required: ["tickers"],
    },
  },
  {
    name: "close_perp_position",
    description: "Close an existing perp position with a reduceOnly market order. Closing a long requires side=long. Closing a short requires side=short.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. ETHUSDT" },
        side:   { type: "string", description: "Position side being closed: long or short" },
        qty:    { type: "number", description: "Base coin qty to close" },
      },
      required: ["symbol", "side", "qty"],
    },
  },
];
