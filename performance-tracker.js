/**
 * performance-tracker.js
 * Logs every live trade outcome and compares it to backtest expectations.
 * Detects when live performance diverges from model predictions.
 *
 * Used by adaptive.js to decide when re-evaluation is needed.
 */

import fs   from "fs";
import path from "path";

const DB_PATH = process.env.TRADE_LOG_PATH || "./data/live-trades.json";

// ─── Storage ──────────────────────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(DB_PATH)) return { trades: [], lastEvalAt: null, lastEvalTradeCount: 0 };
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function save(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ─── Record a completed live trade ───────────────────────────────────────────

/**
 * Call this after every trade closes (stop hit, TP hit, or manual close).
 *
 * @param {object} trade
 *   trade.symbol        string   e.g. "ETHUSDT"
 *   trade.venue         string   e.g. "hl", "bybit", "dydx"
 *   trade.strategy      string   "funding_arb" | "strong_signal" | "composite_signal"
 *   trade.side          string   "long" | "short" | "arb"
 *   trade.score         number   signal score at entry (0–100)
 *   trade.entryPrice    number
 *   trade.exitPrice     number
 *   trade.sizeUsd       number
 *   trade.pnl           number   realised P&L in USD
 *   trade.exitReason    string   "take_profit" | "stop_loss" | "funding_arb" | "manual"
 *   trade.openedAt      string   ISO timestamp
 *   trade.closedAt      string   ISO timestamp
 */
export function recordTrade(trade) {
  const db = load();
  db.trades.push({
    ...trade,
    id:        `lt-${Date.now()}`,
    recordedAt: new Date().toISOString(),
    win:       trade.pnl > 0,
    pnlPct:    +((trade.pnl / trade.sizeUsd) * 100).toFixed(3),
  });
  save(db);
  return db.trades.length;
}

// ─── Re-evaluation trigger check ─────────────────────────────────────────────

const RETRIGGER_TRADE_COUNT = 20;   // re-evaluate after this many new live trades
const RETRIGGER_DAYS        = 7;    // or after this many days, whichever comes first

/**
 * Returns true if it's time to run re-evaluation.
 */
export function shouldReEvaluate() {
  const db = load();
  const tradesSinceLast = db.trades.length - (db.lastEvalTradeCount || 0);

  if (tradesSinceLast >= RETRIGGER_TRADE_COUNT) {
    return { yes: true, reason: `${tradesSinceLast} new live trades since last eval` };
  }

  if (db.lastEvalAt) {
    const daysSince = (Date.now() - new Date(db.lastEvalAt).getTime()) / 86_400_000;
    if (daysSince >= RETRIGGER_DAYS) {
      return { yes: true, reason: `${daysSince.toFixed(1)} days since last eval` };
    }
  } else {
    return { yes: true, reason: "first evaluation" };
  }

  return { yes: false, reason: `${tradesSinceLast}/${RETRIGGER_TRADE_COUNT} trades, ${
    ((Date.now() - new Date(db.lastEvalAt).getTime()) / 86_400_000).toFixed(1)
  }/${RETRIGGER_DAYS} days` };
}

export function markEvaluated() {
  const db = load();
  db.lastEvalAt         = new Date().toISOString();
  db.lastEvalTradeCount = db.trades.length;
  save(db);
}

// ─── Live performance summary ─────────────────────────────────────────────────

/**
 * Compute live win rates and compare to backtest benchmarks.
 * Returns divergence flags where live is underperforming significantly.
 */
export function getLivePerformance(windowTrades = 50) {
  const db    = load();
  const recent = db.trades.slice(-windowTrades);
  if (!recent.length) return null;

  const byStrat = {};
  for (const t of recent) {
    if (!byStrat[t.strategy]) byStrat[t.strategy] = { n: 0, wins: 0, pnl: 0 };
    byStrat[t.strategy].n++;
    if (t.win) byStrat[t.strategy].wins++;
    byStrat[t.strategy].pnl += t.pnl;
  }

  // Backtest benchmarks (from strategy.js design targets)
  const BENCHMARKS = {
    funding_arb:       { winRate: 85, minWinRate: 70 },
    strong_signal:     { winRate: 60, minWinRate: 48 },
    composite_signal:  { winRate: 55, minWinRate: 43 },
  };

  const divergences = [];
  for (const [strat, v] of Object.entries(byStrat)) {
    const liveWr  = (v.wins / v.n) * 100;
    const bench   = BENCHMARKS[strat];
    if (!bench) continue;
    if (liveWr < bench.minWinRate) {
      divergences.push({
        strategy:     strat,
        liveWinRate:  +liveWr.toFixed(1),
        benchmark:    bench.winRate,
        minAllowed:   bench.minWinRate,
        gap:          +(bench.winRate - liveWr).toFixed(1),
        severity:     liveWr < bench.minWinRate - 10 ? "critical" : "warning",
      });
    }
  }

  const totalPnl = recent.reduce((a, t) => a + t.pnl, 0);
  const wins     = recent.filter(t => t.win);
  const overallWr = (wins.length / recent.length) * 100;

  return {
    tradeCount:    recent.length,
    overallWinRate: +overallWr.toFixed(1),
    totalPnl:      +totalPnl.toFixed(2),
    byStrategy:    byStrat,
    divergences,
    healthy:       divergences.length === 0,
  };
}

// ─── Export for agent use ─────────────────────────────────────────────────────

export function getTrades()    { return load().trades; }
export function getTradeCount(){ return load().trades.length; }
