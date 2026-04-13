/**
 * position-monitor.js
 * Daemon that watches all open positions across every venue.
 * Detects closes (stop hit, TP hit, liquidation, manual) and calls recordTrade().
 *
 * Run alongside the agent:
 *   node position-monitor.js
 *
 * Or add to package.json:
 *   "monitor": "node position-monitor.js"
 *   "start":   "concurrently \"npm run monitor\" \"node agent.js\""
 *
 * Install: npm install concurrently
 */

import fs      from "fs";
import path    from "path";
import { recordTrade }    from "./performance-tracker.js";
import { notifyTrade, notifyError, notifyStep } from "./notify.js";
import { reporter } from "./reporter.js";
import { registerPosition } from "./register-position.js";

// Heavy deps loaded lazily so missing packages don't crash startup
let ethers, Hyperliquid;
async function loadHeavyDeps() {
  if (ethers) return;
  try { ({ ethers } = await import("ethers")); } catch {}
  
}

// Load .env
try {
  fs.readFileSync(".env", "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

// ─── Config ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 10_000;          // check every 30 seconds
const REGISTRY_PATH     = "./data/open-positions.json";
const TESTNET           = process.env.BYBIT_TESTNET !== "false";
const BYBIT_BASE        = TESTNET ? "https://api-testnet.bybit.com" : "https://api.bybit.com";
const MARKET_URL        = "https://api.bybit.com"; // always mainnet for real prices

// ─── Dynamic Exit Config ──────────────────────────────────────────────────────
const TRAIL_ACTIVATE_PCT  = 3.0;    // move stop to breakeven when profit ≥ +3%
const TRAIL_START_PCT     = 5.0;    // begin trailing 1.5% below price when ≥ +5%
const TRAIL_OFFSET_PCT    = 1.5;    // trailing stop distance from current price
const PARTIAL_EXIT_PCT    = 4.0;    // close 50% of position when profit ≥ +4%
const EXTENDED_TP_PCT     = 9.0;    // extend TP to +9% when momentum is strong
const TIME_EXIT_HOURS     = 6;      // close flat positions after N hours
const TIME_EXIT_FLAT_PCT  = 1.0;    // "flat" = abs unrealised % below this
const FUNDING_FLIP_LONG   = 0.0004; // funding rate above this = long pays → close
const FUNDING_FLIP_SHORT  =-0.0004; // funding rate below this = short pays → close

// ─── Execute actual closing orders on Bybit ──────────────────────────────────

async function placeOrder(category, symbol, side, qty, extraParams = {}) {
  if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) return null;
  const body = JSON.stringify({
    category, symbol: symbol.toUpperCase(), side, orderType: "Market",
    qty: qty.toString(), timeInForce: "IOC", ...extraParams,
  });
  const ts  = Date.now().toString();
  const rw  = "5000";
  const sig = hmac(`${ts}${process.env.BYBIT_API_KEY}${rw}${body}`);
  try {
    const res = await fetch(`${BYBIT_BASE}/v5/order/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": process.env.BYBIT_API_KEY,
        "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": rw, "X-BAPI-SIGN": sig,
      },
      body,
    });
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(data.retMsg);
    console.log(`[monitor] ✅ order placed: orderId=${data.result.orderId} ${category} ${side} qty=${qty} ${symbol}`);
    return data.result;
  } catch (e) {
    console.warn(`[monitor] ⚠️  order failed (${symbol} qty=${qty}): ${e.message}`);
    return null;
  }
}

async function placeMarketSell(symbol, baseQty) {
  if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) return null;
  const body = JSON.stringify({
    category:    "spot",
    symbol:      symbol.toUpperCase(),
    side:        "Sell",
    orderType:   "Market",
    qty:         baseQty.toString(),
    timeInForce: "IOC",
  });
  const ts  = Date.now().toString();
  const rw  = "5000";
  const sig = hmac(`${ts}${process.env.BYBIT_API_KEY}${rw}${body}`);
  try {
    const res = await fetch(`${BYBIT_BASE}/v5/order/create`, {
      method: "POST",
      headers: {
        "Content-Type":       "application/json",
        "X-BAPI-API-KEY":     process.env.BYBIT_API_KEY,
        "X-BAPI-TIMESTAMP":   ts,
        "X-BAPI-RECV-WINDOW": rw,
        "X-BAPI-SIGN":        sig,
      },
      body,
    });
    const data = await res.json();
    if (data.retCode !== 0) throw new Error(data.retMsg);
    console.log(`[monitor] ✅ sell order placed: orderId=${data.result.orderId} qty=${baseQty} ${symbol}`);
    return data.result;
  } catch (e) {
    console.warn(`[monitor] ⚠️  sell order failed (${symbol} qty=${baseQty}): ${e.message}`);
    return null;
  }
}

// ─── Registry (persisted to disk) ────────────────────────────────────────────
// When agent.js places an order it writes here. Monitor reads and reconciles.

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return { positions: [] };
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
}

function saveRegistry(reg) {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}


// ─── Bybit position reconciler ────────────────────────────────────────────────

async function fetchBybitPositions() {
  if (!process.env.BYBIT_API_KEY) return [];
  try {
    const ts  = Date.now().toString();
    const rw  = "5000";
    const qs  = "category=spot&settleCoin=USDT";
    const raw = `${ts}${process.env.BYBIT_API_KEY}${rw}${qs}`;
    const sig = await hmac(raw);
    const res = await fetch(`${BYBIT_BASE}/v5/position/list?${qs}`, {
      headers: { "X-BAPI-API-KEY": process.env.BYBIT_API_KEY, "X-BAPI-TIMESTAMP": ts,
                 "X-BAPI-RECV-WINDOW": rw, "X-BAPI-SIGN": sig },
    });
    const data = await res.json();
    return (data.result?.list || []).map(p => ({
      symbol: p.symbol, side: p.side?.toLowerCase(),
      size:   parseFloat(p.size || 0),
      avgPrice: parseFloat(p.avgPrice || 0),
    }));
  } catch (e) {
    console.warn("[monitor] bybit position fetch error:", e.message);
    return [];
  }
}

async function fetchBybitOrderStatus(orderId, symbol) {
  if (!process.env.BYBIT_API_KEY || !orderId) return null;
  try {
    const ts  = Date.now().toString();
    const rw  = "5000";
    const qs  = `category=spot&orderId=${orderId}&symbol=${symbol}`;
    const raw = `${ts}${process.env.BYBIT_API_KEY}${rw}${qs}`;
    const sig = await hmac(raw);
    const res = await fetch(`${BYBIT_BASE}/v5/order/realtime?${qs}`, {
      headers: { "X-BAPI-API-KEY": process.env.BYBIT_API_KEY, "X-BAPI-TIMESTAMP": ts,
                 "X-BAPI-RECV-WINDOW": rw, "X-BAPI-SIGN": sig },
    });
    const data = await res.json();
    return data.result?.list?.[0] || null;
  } catch (e) { return null; }
}

async function fetchBybitTicker(symbol, category = "spot") {
  try {
    const res  = await fetch(`${MARKET_URL}/v5/market/tickers?category=${category}&symbol=${symbol}`);
    const data = await res.json();
    return parseFloat(data.result?.list?.[0]?.lastPrice || 0);
  } catch (e) { return null; }
}

// ─── Hyperliquid reconciler ───────────────────────────────────────────────────

let _hl = null;
function getHL() {
  if (!_hl && Hyperliquid && process.env.WALLET_PRIVATE_KEY) {
    _hl = new Hyperliquid({
      privateKey: process.env.WALLET_PRIVATE_KEY,
      testnet:    process.env.HL_TESTNET !== "false",
    });
  }
  return _hl;
}

async function fetchHLPositions() {
  await loadHeavyDeps();
  const hl = getHL();
  if (!hl) return [];
  try {
    const wallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY);
    const state  = await hl.info.perpetuals.getClearinghouseState(wallet.address);
    return (state.assetPositions || [])
      .filter(p => parseFloat(p.position?.szi || 0) !== 0)
      .map(p => ({
        coin:       p.position.coin,
        szi:        parseFloat(p.position.szi),
        entryPx:    parseFloat(p.position.entryPx),
        unrealPnl:  parseFloat(p.position.unrealizedPnl || 0),
        markPx:     parseFloat(p.position.markPx || p.position.entryPx),
      }));
  } catch (e) {
    console.warn("[monitor] HL position fetch error:", e.message);
    return [];
  }
}

// ─── HMAC helper (shared with bybit-agent-tools.js) ──────────────────────────

import crypto from "crypto";
function hmac(raw) {
  return crypto.createHmac("sha256", process.env.BYBIT_API_SECRET || "").update(raw).digest("hex");
}

// ─── Dynamic exit helpers ────────────────────────────────────────────────────

/** Update trailing stop. Returns true if pos.stopPrice was changed. */
function updateTrailingStop(pos, currentPrice, pctProfit, isLong) {
  let changed = false;

  // Stage 1: move stop to breakeven once +TRAIL_ACTIVATE_PCT
  if (pctProfit >= TRAIL_ACTIVATE_PCT && !pos.trailActivated) {
    const breakevenStop = isLong
      ? +(pos.entryPrice * 1.001).toFixed(8)   // just above entry
      : +(pos.entryPrice * 0.999).toFixed(8);  // just below entry
    if (isLong ? breakevenStop > pos.stopPrice : breakevenStop < pos.stopPrice) {
      pos.stopPrice    = breakevenStop;
      pos.trailActivated = true;
      changed = true;
      console.log(`[monitor] 📌 BREAKEVEN: ${pos.symbol} stop → $${pos.stopPrice} (+${pctProfit.toFixed(1)}% profit)`);
    }
  }

  // Stage 2: trail stop once +TRAIL_START_PCT
  if (pctProfit >= TRAIL_START_PCT) {
    const trailStop = isLong
      ? +(currentPrice * (1 - TRAIL_OFFSET_PCT / 100)).toFixed(8)
      : +(currentPrice * (1 + TRAIL_OFFSET_PCT / 100)).toFixed(8);
    // Only move stop in the favourable direction (never loosen)
    if (isLong ? trailStop > pos.stopPrice : trailStop < pos.stopPrice) {
      pos.stopPrice = trailStop;
      changed = true;
      console.log(`[monitor] 🔄 TRAIL: ${pos.symbol} stop → $${pos.stopPrice} (${TRAIL_OFFSET_PCT}% from $${currentPrice})`);
    }
  }

  return changed;
}

/** Fetch current funding rate for a linear perp symbol. */
async function fetchFundingRate(symbol) {
  try {
    const res  = await fetch(`${MARKET_URL}/v5/market/tickers?category=linear&symbol=${symbol}`);
    const data = await res.json();
    return parseFloat(data.result?.list?.[0]?.fundingRate || 0);
  } catch { return null; }
}

/** Calculate 14-period RSI from Bybit 1h klines. */
async function fetch1hRSI(symbol) {
  try {
    const res  = await fetch(`${MARKET_URL}/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=30`);
    const data = await res.json();
    const closes = (data.result?.list || []).map(k => parseFloat(k[4])).reverse(); // [open_time,open,high,low,close,vol]
    if (closes.length < 15) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= 14; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    const avgGain = gains / 14, avgLoss = losses / 14;
    if (avgLoss === 0) return 100;
    const rs  = avgGain / avgLoss;
    return +(100 - 100 / (1 + rs)).toFixed(1);
  } catch { return null; }
}

/** Execute a partial close (50%) of a bybit-perp position. */
async function executePartialClose(pos, currentPrice) {
  const isLong  = pos.side === "long";
  const closeSide = isLong ? "Sell" : "Buy";
  const fullQty   = pos.sizeUsd / pos.entryPrice;
  const halfQty   = +(fullQty * 0.5).toFixed(6);

  console.log(`[monitor] ✂️  PARTIAL EXIT: ${pos.symbol} closing 50% (${halfQty} units) at $${currentPrice}`);
  const r = await placeOrder("linear", pos.symbol, closeSide, halfQty, { reduceOnly: true, positionIdx: 0 });

  const exitPx   = r ? parseFloat(r.avgPrice || r.price || currentPrice) : currentPrice;
  const halfUsd  = pos.sizeUsd * 0.5;
  const halfPnl  = isLong
    ? +((exitPx - pos.entryPrice) / pos.entryPrice * halfUsd).toFixed(2)
    : +((pos.entryPrice - exitPx) / pos.entryPrice * halfUsd).toFixed(2);

  // Update position to reflect remaining half
  pos.partialClosed     = true;
  pos.partialExitPrice  = exitPx;
  pos.partialPnl        = halfPnl;
  pos.sizeUsd           = +(pos.sizeUsd * 0.5).toFixed(2); // remaining half

  // Extend TP on remaining half — let it ride further
  pos.tpPrice = isLong
    ? +(pos.entryPrice * (1 + EXTENDED_TP_PCT / 100)).toFixed(8)
    : +(pos.entryPrice * (1 - EXTENDED_TP_PCT / 100)).toFixed(8);

  console.log(`[monitor] ✂️  Partial closed: P&L +$${halfPnl} | remaining ${pos.sizeUsd} USD | new TP $${pos.tpPrice}`);
  reporter.feed(`✂️ PARTIAL EXIT ${pos.symbol} ${pos.side.toUpperCase()} — closed 50% @ $${exitPx} | P&L +$${halfPnl} | TP extended to $${pos.tpPrice}`, "sell");
  reporter.position(pos);
}

// ─── Close detector ───────────────────────────────────────────────────────────

/**
 * For a registered position, check if it has closed on its venue.
 * Returns { closed, exitPrice, exitReason } or null if still open.
 */
async function checkIfClosed(pos) {
  const now = Date.now();

  if (pos.venue === "bybit" || pos.venue === "bybit-perp") {
    const category = pos.venue === "bybit-perp" ? "linear" : "spot";
    const price = await fetchBybitTicker(pos.symbol, category);
    if (!price) return null;

    const isLong = pos.side === "long" || pos.side === "buy";
    const distToStop = pos.stopPrice ? ((price - pos.stopPrice) / pos.stopPrice * 100).toFixed(2) : '?';
    const distToTp   = pos.tpPrice   ? ((pos.tpPrice - price)   / pos.tpPrice   * 100).toFixed(2) : '?';
    console.log(`[monitor] ${pos.venue} ${pos.symbol} ${pos.side} | now $${price} | stop $${pos.stopPrice} (${distToStop}% away) | tp $${pos.tpPrice} (${distToTp}% away)`);

    if (isLong) {
      if (pos.stopPrice && pos.stopPrice > 0 && price <= pos.stopPrice)
        return { closed: true, exitPrice: price, exitReason: "stop_loss" };
      if (pos.tpPrice   && pos.tpPrice   > 0 && price >= pos.tpPrice)
        return { closed: true, exitPrice: price, exitReason: "take_profit" };
    } else {
      if (pos.stopPrice && pos.stopPrice > 0 && price >= pos.stopPrice)
        return { closed: true, exitPrice: price, exitReason: "stop_loss" };
      if (pos.tpPrice   && pos.tpPrice   > 0 && price <= pos.tpPrice)
        return { closed: true, exitPrice: price, exitReason: "take_profit" };
    }
    return null;
  }

  if (pos.venue === "hl") {
    const hlPositions = await fetchHLPositions();
    const coin        = pos.symbol.replace("USDT","").replace("-PERP","");
    const live        = hlPositions.find(p => p.coin === coin);

    // If position no longer in HL state, it closed
    if (!live) {
      // Estimate exit price from last known mark price or use entry (conservative)
      return { closed: true, exitPrice: pos.entryPrice, exitReason: "closed_on_venue" };
    }

    // Check stop/TP against current mark price
    if (pos.side === "long") {
      if (pos.stopPrice && live.markPx <= pos.stopPrice)
        return { closed: true, exitPrice: pos.stopPrice, exitReason: "stop_loss" };
      if (pos.tpPrice   && live.markPx >= pos.tpPrice)
        return { closed: true, exitPrice: pos.tpPrice,   exitReason: "take_profit" };
    } else {
      if (pos.stopPrice && live.markPx >= pos.stopPrice)
        return { closed: true, exitPrice: pos.stopPrice, exitReason: "stop_loss" };
      if (pos.tpPrice   && live.markPx <= pos.tpPrice)
        return { closed: true, exitPrice: pos.tpPrice,   exitReason: "take_profit" };
    }
    return null;
  }

  // dYdX / GMX / Uniswap — price-based stop/TP monitoring only
  // (full on-chain reconciliation requires venue-specific subgraph queries)
  if (["dydx","gmx","uniswap"].includes(pos.venue)) {
    const ticker = await fetchBybitTicker(pos.symbol); // use Bybit as price oracle
    if (!ticker) return null;
    if (pos.side === "long") {
      if (pos.stopPrice && ticker <= pos.stopPrice)
        return { closed: true, exitPrice: pos.stopPrice, exitReason: "stop_loss" };
      if (pos.tpPrice   && ticker >= pos.tpPrice)
        return { closed: true, exitPrice: pos.tpPrice,   exitReason: "take_profit" };
    } else {
      if (pos.stopPrice && ticker >= pos.stopPrice)
        return { closed: true, exitPrice: pos.stopPrice, exitReason: "stop_loss" };
      if (pos.tpPrice   && ticker <= pos.tpPrice)
        return { closed: true, exitPrice: pos.tpPrice,   exitReason: "take_profit" };
    }
    return null;
  }

  return null;
}

// ─── P&L calculator ───────────────────────────────────────────────────────────

const FEE = 0.0006; // 0.06% taker, each side

function calcPnl(pos, exitPrice) {
  const qty    = pos.sizeUsd / pos.entryPrice;
  const isLong = pos.side === "long" || pos.side === "buy";
  const raw    = isLong
    ? (exitPrice - pos.entryPrice) * qty
    : (pos.entryPrice - exitPrice) * qty;
  const fees   = pos.sizeUsd * FEE * 2;
  return +(raw - fees).toFixed(4);
}

// ─── Main poll loop ───────────────────────────────────────────────────────────

async function poll() {
  const reg  = loadRegistry();
  const open = reg.positions.filter(p => p.status === "open");
  if (!open.length) return;

  console.log(`[monitor] checking ${open.length} open position(s)...`);
  let changed = false;

  for (const pos of open) {
    try {
      const isLong = pos.side === "long" || pos.side === "buy";
      const isPerpPos = pos.venue === "bybit-perp";

      // ── Smart exit logic (perps only) ─────────────────────────────────
      if (isPerpPos) {
        const category    = "linear";
        const currentPrice = await fetchBybitTicker(pos.symbol, category);
        if (currentPrice) {
          const pctProfit = isLong
            ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
            : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;

          // ─ 1. Trailing stop ──────────────────────────────────────────
          const trailChanged = updateTrailingStop(pos, currentPrice, pctProfit, isLong);
          if (trailChanged) { changed = true; reporter.position(pos); }

          // ─ 2. Partial exit at +4% ────────────────────────────────────
          if (!pos.partialClosed && pctProfit >= PARTIAL_EXIT_PCT) {
            await executePartialClose(pos, currentPrice);
            changed = true;
          }

          // ─ 3. RSI-based dynamic TP ───────────────────────────────────
          if (pctProfit >= 3.0 && !pos.tpExtended) {
            const rsi = await fetch1hRSI(pos.symbol);
            if (rsi != null) {
              const momentumBuilding = isLong ? (rsi >= 40 && rsi <= 65) : (rsi >= 35 && rsi <= 60);
              const momentumFading   = isLong ? rsi > 68 : rsi < 32;

              if (momentumBuilding) {
                // Extend TP — let the winner run
                const extTP = isLong
                  ? +(pos.entryPrice * (1 + EXTENDED_TP_PCT / 100)).toFixed(8)
                  : +(pos.entryPrice * (1 - EXTENDED_TP_PCT / 100)).toFixed(8);
                if (isLong ? extTP > pos.tpPrice : extTP < pos.tpPrice) {
                  pos.tpPrice    = extTP;
                  pos.tpExtended = true;
                  changed = true;
                  console.log(`[monitor] 🚀 TP EXTENDED: ${pos.symbol} → $${pos.tpPrice} (RSI ${rsi}, momentum building)`);
                  reporter.feed(`🚀 TP EXTENDED ${pos.symbol} → $${pos.tpPrice} (RSI ${rsi}, +${pctProfit.toFixed(1)}% profit, letting winner run)`, "sys");
                  reporter.position(pos);
                }
              } else if (momentumFading && pctProfit >= 3.0) {
                // Momentum reversing — take profit early
                console.log(`[monitor] ⚡ EARLY TP: ${pos.symbol} +${pctProfit.toFixed(1)}% profit, RSI ${rsi} momentum fading`);
                reporter.feed(`⚡ EARLY EXIT ${pos.symbol} — RSI ${rsi} fading at +${pctProfit.toFixed(1)}% profit`, "sell");
                const closeResult = { closed: true, exitPrice: currentPrice, exitReason: "early_tp_momentum_fade" };
                // Fall through to close logic below
                const baseQty2  = +(pos.sizeUsd / pos.entryPrice).toFixed(6);
                const closeSide2 = isLong ? "Sell" : "Buy";
                const r2 = await placeOrder("linear", pos.symbol, closeSide2, baseQty2, { reduceOnly: true, positionIdx: 0 });
                let exitPx2 = currentPrice;
                if (r2) { const px = parseFloat(r2.avgPrice || r2.price || 0); if (px > 0) exitPx2 = px; }
                const pnl2      = calcPnl(pos, exitPx2);
                const closedAt2 = new Date().toISOString();
                pos.status = "closed"; pos.closedAt = closedAt2; pos.exitPrice = exitPx2;
                pos.exitReason = "early_tp_momentum_fade"; pos.pnl = pnl2;
                changed = true;
                recordTrade({ symbol: pos.symbol, venue: pos.venue, strategy: pos.strategy || "unknown", side: pos.side, score: pos.score || 0, entryPrice: pos.entryPrice, exitPrice: exitPx2, sizeUsd: pos.sizeUsd, pnl: pnl2, exitReason: "early_tp_momentum_fade", openedAt: pos.openedAt, closedAt: closedAt2 });
                reporter.trade({ symbol: pos.symbol, venue: pos.venue, side: pos.side, entryPrice: pos.entryPrice, exitPrice: exitPx2, sizeUsd: pos.sizeUsd, pnl: pnl2, exitReason: "early_tp_momentum_fade", openedAt: pos.openedAt, closedAt: closedAt2 });
                reporter.position({ ...pos });
                await notifyStep("trade_close", `⚡ ${pos.symbol} ${pos.side.toUpperCase()} early exit — momentum fade | P&L: +$${pnl2} | RSI ${rsi}`);
                continue;
              }
            }
          }

          // ─ 4. Funding rate flip ──────────────────────────────────────
          const fr = await fetchFundingRate(pos.symbol);
          if (fr != null) {
            const fundingFlipped = isLong
              ? fr > FUNDING_FLIP_LONG     // long now paying high fee
              : fr < FUNDING_FLIP_SHORT;   // short now paying high fee
            if (fundingFlipped) {
              console.log(`[monitor] 💸 FUNDING FLIP: ${pos.symbol} ${pos.side} — funding=${(fr*100).toFixed(4)}%/8h flipped against position`);
              reporter.feed(`💸 FUNDING FLIP EXIT ${pos.symbol} — rate ${(fr*100).toFixed(4)}%/8h now against ${pos.side.toUpperCase()}, closing`, "sys");
              const baseQtyF  = +(pos.sizeUsd / pos.entryPrice).toFixed(6);
              const closeSideF = isLong ? "Sell" : "Buy";
              const rF = await placeOrder("linear", pos.symbol, closeSideF, baseQtyF, { reduceOnly: true, positionIdx: 0 });
              let exitPxF = currentPrice;
              if (rF) { const px = parseFloat(rF.avgPrice || rF.price || 0); if (px > 0) exitPxF = px; }
              const pnlF = calcPnl(pos, exitPxF);
              const closedAtF = new Date().toISOString();
              pos.status = "closed"; pos.closedAt = closedAtF; pos.exitPrice = exitPxF;
              pos.exitReason = `funding_flip`; pos.pnl = pnlF;
              changed = true;
              recordTrade({ symbol: pos.symbol, venue: pos.venue, strategy: pos.strategy||"unknown", side: pos.side, score: pos.score||0, entryPrice: pos.entryPrice, exitPrice: exitPxF, sizeUsd: pos.sizeUsd, pnl: pnlF, exitReason: "funding_flip", openedAt: pos.openedAt, closedAt: closedAtF });
              reporter.trade({ symbol: pos.symbol, venue: pos.venue, side: pos.side, entryPrice: pos.entryPrice, exitPrice: exitPxF, sizeUsd: pos.sizeUsd, pnl: pnlF, exitReason: "funding_flip", openedAt: pos.openedAt, closedAt: closedAtF });
              reporter.position({ ...pos });
              await notifyStep("trade_close", `💸 ${pos.symbol} ${pos.side.toUpperCase()} funding flip exit | P&L: $${pnlF} | rate: ${(fr*100).toFixed(4)}%`);
              continue;
            }
          }

          // ─ 5. Time-based exit ────────────────────────────────────────
          if (pos.openedAt) {
            const ageHours = (Date.now() - new Date(pos.openedAt).getTime()) / 3600000;
            if (ageHours >= TIME_EXIT_HOURS && Math.abs(pctProfit) < TIME_EXIT_FLAT_PCT) {
              console.log(`[monitor] ⏰ TIME EXIT: ${pos.symbol} flat ${pctProfit.toFixed(1)}% after ${ageHours.toFixed(1)}h — freeing slot`);
              reporter.feed(`⏰ TIME EXIT ${pos.symbol} — ${ageHours.toFixed(1)}h, ${pctProfit.toFixed(1)}% flat, freeing slot`, "sys");
              const baseQtyT  = +(pos.sizeUsd / pos.entryPrice).toFixed(6);
              const closeSideT = isLong ? "Sell" : "Buy";
              const rT = await placeOrder("linear", pos.symbol, closeSideT, baseQtyT, { reduceOnly: true, positionIdx: 0 });
              let exitPxT = currentPrice;
              if (rT) { const px = parseFloat(rT.avgPrice || rT.price || 0); if (px > 0) exitPxT = px; }
              const pnlT = calcPnl(pos, exitPxT);
              const closedAtT = new Date().toISOString();
              pos.status = "closed"; pos.closedAt = closedAtT; pos.exitPrice = exitPxT;
              pos.exitReason = "time_exit"; pos.pnl = pnlT;
              changed = true;
              recordTrade({ symbol: pos.symbol, venue: pos.venue, strategy: pos.strategy||"unknown", side: pos.side, score: pos.score||0, entryPrice: pos.entryPrice, exitPrice: exitPxT, sizeUsd: pos.sizeUsd, pnl: pnlT, exitReason: "time_exit", openedAt: pos.openedAt, closedAt: closedAtT });
              reporter.trade({ symbol: pos.symbol, venue: pos.venue, side: pos.side, entryPrice: pos.entryPrice, exitPrice: exitPxT, sizeUsd: pos.sizeUsd, pnl: pnlT, exitReason: "time_exit", openedAt: pos.openedAt, closedAt: closedAtT });
              reporter.position({ ...pos });
              await notifyStep("trade_close", `⏰ ${pos.symbol} ${pos.side.toUpperCase()} time exit after ${ageHours.toFixed(1)}h flat | P&L: $${pnlT}`);
              continue;
            }
          }
        }
      }

      // ── Standard stop / TP check ──────────────────────────────────────
      const result = await checkIfClosed(pos);
      if (!result?.closed) continue;

      // ── Execute the actual closing order on the exchange ─────────────
      let actualExitPrice = result.exitPrice;
      const baseQty = +(pos.sizeUsd / pos.entryPrice).toFixed(6);

      if (pos.venue === "bybit" && isLong) {
        // Spot long close — sell base coin
        const r = await placeMarketSell(pos.symbol, baseQty);
        if (r) { const px = parseFloat(r.avgPrice || r.price || 0); if (px > 0) actualExitPrice = px; }
      } else if (pos.venue === "bybit-perp") {
        // Perp close — reduceOnly opposite side
        const closeSide = isLong ? "Sell" : "Buy";
        const r = await placeOrder("linear", pos.symbol, closeSide, baseQty, { reduceOnly: true, positionIdx: 0 });
        if (r) { const px = parseFloat(r.avgPrice || r.price || 0); if (px > 0) actualExitPrice = px; }
      }

      // ── Position closed ────────────────────────────────────────────────
      const pnl      = pos.side === "arb" ? pos.sizeUsd * 0.001 : calcPnl(pos, actualExitPrice);
      const closedAt = new Date().toISOString();

      pos.status     = "closed";
      pos.closedAt   = closedAt;
      pos.exitPrice  = actualExitPrice;
      pos.exitReason = result.exitReason;
      pos.pnl        = pnl;
      changed        = true;

      console.log(`[monitor] CLOSED: ${pos.venue} ${pos.symbol} ${pos.side} | exit: $${actualExitPrice} | P&L: $${pnl} | reason: ${result.exitReason}`);

      // ── Record to performance tracker ─────────────────────────────────
      const tradeRecord = {
        symbol:      pos.symbol,
        venue:       pos.venue,
        strategy:    pos.strategy || "unknown",
        side:        pos.side,
        score:       pos.score || 0,
        entryPrice:  pos.entryPrice,
        exitPrice:   result.exitPrice,
        sizeUsd:     pos.sizeUsd,
        pnl,
        exitReason:  result.exitReason,
        openedAt:    pos.openedAt,
        closedAt,
      };
      recordTrade(tradeRecord);

      // ── Update entry log with outcome ──────────────────────────────────
      try {
        const ENTRY_LOG_PATH = "./data/entry-log.json";
        let log = [];
        try { log = JSON.parse(fs.readFileSync(ENTRY_LOG_PATH, "utf8")); } catch {}
        // Match by posId (stored in pos.id) or by symbol + openedAt proximity
        let matched = false;
        for (const entry of log) {
          if (entry.id === pos.id || (entry.symbol === pos.symbol && entry.outcome === "open")) {
            entry.outcome   = pnl > 0 ? "won" : "lost";
            entry.exitPrice = actualExitPrice;
            entry.exitReason = result.exitReason;
            entry.pnl       = pnl;
            entry.closedAt  = closedAt;
            matched = true;
            break;
          }
        }
        if (matched) fs.writeFileSync(ENTRY_LOG_PATH, JSON.stringify(log, null, 2));
      } catch {}

      // ── Push closed trade + updated position to dashboard ─────────────
      reporter.trade(tradeRecord);
      reporter.position({ ...pos, status: "closed", closedAt, exitPrice: result.exitPrice, pnl });

      // ── Notify ────────────────────────────────────────────────────────
      const emoji    = pnl > 0 ? "✅" : "🔴";
      const duration = ((new Date(closedAt) - new Date(pos.openedAt)) / 3600000).toFixed(1);
      await notifyStep("trade_close",
        `${emoji} ${pos.venue.toUpperCase()} ${pos.symbol} ${pos.side.toUpperCase()} closed\n` +
        `  P&L: ${pnl >= 0 ? "+" : ""}$${pnl} | reason: ${result.exitReason} | held: ${duration}h`
      );

      // ── Tsega: post to team chat ───────────────────────────────────────
      try {
        const { execFile } = await import("child_process");
        execFile("node", ["tsega-report.js", "trade"], { cwd: process.cwd() }, (err, stdout) => {
          if (err) console.warn("[monitor] tsega-report trade error:", err.message);
          else if (stdout.trim()) console.log("[monitor]", stdout.trim());
        });
      } catch {}

    } catch (err) {
      console.warn(`[monitor] error checking ${pos.venue} ${pos.symbol}:`, err.message);
    }
  }

  if (changed) saveRegistry(reg);
}

// ─── Startup summary ──────────────────────────────────────────────────────────

function printSummary() {
  const reg  = loadRegistry();
  const open = reg.positions.filter(p => p.status === "open");
  console.log(`\n[monitor] started — tracking ${open.length} open position(s)`);
  open.forEach(p =>
    console.log(`  · ${p.venue} ${p.symbol} ${p.side} | entry: $${p.entryPrice} | stop: $${p.stopPrice} | tp: $${p.tpPrice}`)
  );
  if (!open.length) console.log("  (none — waiting for agent to open positions)");
}

// ─── Entry point ──────────────────────────────────────────────────────────────

printSummary();

// Sync all open positions to dashboard on startup
(function syncOpenPositions() {
  const reg = loadRegistry();
  reg.positions.filter(p => p.status === "open").forEach(p => reporter.position(p));
})();

poll(); // run immediately on start
const timer = setInterval(poll, POLL_INTERVAL_MS);

// Graceful shutdown
process.on("SIGINT",  () => { clearInterval(timer); console.log("\n[monitor] stopped"); process.exit(0); });
process.on("SIGTERM", () => { clearInterval(timer); process.exit(0); });

console.log(`[monitor] polling every ${POLL_INTERVAL_MS / 1000}s — press Ctrl+C to stop\n`);
