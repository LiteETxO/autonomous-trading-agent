/**
 * tsega-report.js
 * Tsega's reporting bridge — reads trading state and posts to OpenClaw team chat.
 *
 * Usage:
 *   node tsega-report.js              # post 6h cycle summary
 *   node tsega-report.js trade        # post latest closed trade (if any new)
 *   node tsega-report.js alert <msg>  # post custom alert
 *
 * Run automatically: add to cron or call from position-monitor.js on close events.
 */

import fs from "fs";
import path from "path";

const TEAM_CHAT  = "/Users/michaelderibe/.openclaw/workspace/agents/team_chat.json";
const STATE_FILE = "./data/dashboard-state.json";
const LAST_TRADE_FILE = "./data/tsega-last-reported-trade.json";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function postToTeamChat(text) {
  const chat = readJSON(TEAM_CHAT, []);
  chat.push({
    sender: "Tsega",
    to: "Team",
    text,
    timestamp: new Date().toISOString(),
    type: "chat",
  });
  fs.writeFileSync(TEAM_CHAT, JSON.stringify(chat, null, 2));
  console.log("[tsega-report] posted:", text.slice(0, 120));
}

function fmtPnl(n) {
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function winRate(trades) {
  if (!trades.length) return "0% (0/0)";
  const wins = trades.filter(t => (t.pnl || 0) > 0).length;
  return `${((wins / trades.length) * 100).toFixed(0)}% (${wins}/${trades.length})`;
}

// ─── Modes ────────────────────────────────────────────────────────────────────

const mode = process.argv[2] || "summary";

const state = readJSON(STATE_FILE, {
  trades: [], positions: [], metrics: { equity: 0, totalPnl: 0 }, status: "unknown"
});

// ── ALERT mode ────────────────────────────────────────────────────────────────
if (mode === "alert") {
  const msg = process.argv.slice(3).join(" ") || "unknown anomaly";
  postToTeamChat(`TSEGA ALERT | ${msg}`);
  process.exit(0);
}

// ── TRADE mode — post latest closed trade if not yet reported ─────────────────
if (mode === "trade") {
  const lastReported = readJSON(LAST_TRADE_FILE, { lastId: null });
  const closedTrades = (state.trades || []).filter(t => t.closedAt);
  if (!closedTrades.length) {
    console.log("[tsega-report] no closed trades yet");
    process.exit(0);
  }
  const latest = closedTrades[closedTrades.length - 1];
  if (latest.id === lastReported.lastId) {
    console.log("[tsega-report] latest trade already reported");
    process.exit(0);
  }

  const pnl    = latest.pnl || 0;
  const entry  = latest.entryPrice ? `$${parseFloat(latest.entryPrice).toFixed(2)}` : "?";
  const exit_  = latest.exitPrice  ? `$${parseFloat(latest.exitPrice).toFixed(2)}`  : "?";
  const reason = latest.exitReason || "unknown";
  const wr     = winRate(closedTrades);

  postToTeamChat(
    `TRADE CLOSED | ${latest.symbol || "?"} ${(latest.side || "").toUpperCase()} | ` +
    `${entry} → ${exit_} | ${fmtPnl(pnl)} (${reason}) | Win rate: ${wr}`
  );

  fs.writeFileSync(LAST_TRADE_FILE, JSON.stringify({ lastId: latest.id, reportedAt: new Date().toISOString() }, null, 2));
  process.exit(0);
}

// ── SUMMARY mode (default) ────────────────────────────────────────────────────
const openPositions  = (state.positions || []).filter(p => p.status === "open");
const equity         = state.metrics?.equity || 0;
const todayPnl       = state.metrics?.todayPnl || 0;
const agentStatus    = state.status || "unknown";
const closedToday    = (state.trades || []).filter(t => {
  if (!t.closedAt) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  return new Date(t.closedAt) >= today;
});

const openSummary = openPositions.length
  ? openPositions.map(p => `${p.symbol} ${p.side}`).join(", ")
  : "none";

const wr = winRate(state.trades || []);

postToTeamChat(
  `TSEGA | ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Addis_Ababa" })} EAT | ` +
  `Open: ${openPositions.length} (${openSummary}) | ` +
  `Today P&L: ${fmtPnl(todayPnl)} | ` +
  `Equity: $${equity.toFixed(2)} | ` +
  `Overall win rate: ${wr} | ` +
  `Agent: ${agentStatus} ✓`
);
