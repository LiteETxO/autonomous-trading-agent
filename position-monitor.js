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
  try { ({ Hyperliquid } = await import("@hyperliquid/sdk")); } catch {}
}

// Load .env
try {
  fs.readFileSync(".env", "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

// ─── Config ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 30_000;          // check every 30 seconds
const REGISTRY_PATH     = "./data/open-positions.json";
const TESTNET           = process.env.BYBIT_TESTNET !== "false";
const BYBIT_BASE        = TESTNET ? "https://api-testnet.bybit.com" : "https://api.bybit.com";

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

async function fetchBybitTicker(symbol) {
  try {
    const res  = await fetch(`${BYBIT_BASE}/v5/market/tickers?category=spot&symbol=${symbol}`);
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

// ─── Close detector ───────────────────────────────────────────────────────────

/**
 * For a registered position, check if it has closed on its venue.
 * Returns { closed, exitPrice, exitReason } or null if still open.
 */
async function checkIfClosed(pos) {
  const now = Date.now();

  if (pos.venue === "bybit") {
    const price = await fetchBybitTicker(pos.symbol);
    if (!price) return null;

    // Check stop / TP breach
    if (pos.side === "long") {
      if (pos.stopPrice && price <= pos.stopPrice)
        return { closed: true, exitPrice: pos.stopPrice, exitReason: "stop_loss" };
      if (pos.tpPrice   && price >= pos.tpPrice)
        return { closed: true, exitPrice: pos.tpPrice,   exitReason: "take_profit" };
    } else if (pos.side === "short") {
      if (pos.stopPrice && price >= pos.stopPrice)
        return { closed: true, exitPrice: pos.stopPrice, exitReason: "stop_loss" };
      if (pos.tpPrice   && price <= pos.tpPrice)
        return { closed: true, exitPrice: pos.tpPrice,   exitReason: "take_profit" };
    }

    // Check order status if we have an orderId
    if (pos.venueOrderId) {
      const order = await fetchBybitOrderStatus(pos.venueOrderId, pos.symbol);
      if (order && ["Filled","Cancelled","Rejected"].includes(order.orderStatus)) {
        return { closed: true, exitPrice: parseFloat(order.avgPrice || pos.entryPrice),
                 exitReason: order.orderStatus === "Filled" ? "filled" : "cancelled" };
      }
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
  const qty  = pos.sizeUsd / pos.entryPrice;
  const raw  = pos.side === "long"
    ? (exitPrice - pos.entryPrice) * qty
    : (pos.entryPrice - exitPrice) * qty;
  const fees = pos.sizeUsd * FEE * 2;
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
      const result = await checkIfClosed(pos);
      if (!result?.closed) continue;

      // ── Position closed ────────────────────────────────────────────────
      const pnl      = pos.side === "arb" ? pos.sizeUsd * 0.001 : calcPnl(pos, result.exitPrice);
      const closedAt = new Date().toISOString();

      pos.status     = "closed";
      pos.closedAt   = closedAt;
      pos.exitPrice  = result.exitPrice;
      pos.exitReason = result.exitReason;
      pos.pnl        = pnl;
      changed        = true;

      console.log(`[monitor] CLOSED: ${pos.venue} ${pos.symbol} ${pos.side} | exit: $${result.exitPrice} | P&L: $${pnl} | reason: ${result.exitReason}`);

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
