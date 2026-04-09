/**
 * server.js
 * Local dashboard server — bridges the agent to the Mission Control UI.
 *
 * Run:  node server.js          (default port 3000)
 *       PORT=8080 node server.js
 *
 * Install: npm install express (already in package.json after Claude Code adds it)
 *
 * Agent posts events here. Dashboard reads from here via SSE + REST.
 */

import express  from "express";
import fs       from "fs";
import path     from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard")));

// ─── State (in-memory + persisted to data/dashboard-state.json) ──────────────

const STATE_FILE = "./data/dashboard-state.json";

const DEFAULT_STATE = {
  status:      "idle",       // "running" | "idle" | "paused" | "error"
  currentTask: "",
  feed:        [],           // last 200 activity entries
  trades:      [],           // all recorded trades
  positions:   [],           // currently open positions
  equity:      [],           // equity curve [{ts, value}]
  metrics:     { totalPnl: 0, winRate: 0, openPositions: 0, todayPnl: 0, equity: 0 },
  params:      {},
  lastUpdated: null,
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {}
  return { ...DEFAULT_STATE };
}

function saveState(s) {
  try {
    fs.mkdirSync("./data", { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch {}
}

let state = loadState();

// ─── SSE clients (live push to dashboard) ────────────────────────────────────

const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(msg); } catch {} });
}

app.get("/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write(`event: init\ndata: ${JSON.stringify(state)}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// ─── Agent → server endpoints ─────────────────────────────────────────────────

// POST /agent/status   { status, task }
app.post("/agent/status", (req, res) => {
  const { status, task } = req.body;
  state.status      = status || state.status;
  state.currentTask = task  || state.currentTask;
  state.lastUpdated = new Date().toISOString();
  saveState(state);
  broadcast("status", { status: state.status, task: state.currentTask });
  res.json({ ok: true });
});

// POST /agent/feed    { message, type }
// types: sys | tool | think | buy | sell | pass | error
app.post("/agent/feed", (req, res) => {
  const entry = { ts: new Date().toISOString(), ...req.body };
  state.feed.push(entry);
  if (state.feed.length > 200) state.feed = state.feed.slice(-200);
  saveState(state);
  broadcast("feed", entry);
  res.json({ ok: true });
});

// POST /agent/trade   { symbol, venue, side, sizeUsd, entryPrice, exitPrice, pnl, strategy, score, exitReason, openedAt, closedAt }
app.post("/agent/trade", (req, res) => {
  const trade = { id: `t-${Date.now()}`, ...req.body };
  state.trades.push(trade);
  if (state.trades.length > 500) state.trades = state.trades.slice(-500);

  // Recalculate metrics
  const recent = state.trades.slice(-50);
  const wins   = recent.filter(t => t.pnl > 0);
  state.metrics.winRate      = recent.length ? +(wins.length / recent.length * 100).toFixed(1) : 0;
  state.metrics.totalPnl     = +state.trades.reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2);
  state.metrics.openPositions = state.positions.filter(p => p.status === "open").length;

  // Today P&L
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  state.metrics.todayPnl = +state.trades
    .filter(t => new Date(t.closedAt) >= todayStart)
    .reduce((a, t) => a + (t.pnl || 0), 0).toFixed(2);

  saveState(state);
  broadcast("trade", trade);
  broadcast("metrics", state.metrics);
  res.json({ ok: true });
});

// POST /agent/position  { id, venue, symbol, side, sizeUsd, entryPrice, stopPrice, tpPrice, status, openedAt }
app.post("/agent/position", (req, res) => {
  const pos = req.body;
  const idx = state.positions.findIndex(p => p.id === pos.id);
  if (idx >= 0) state.positions[idx] = pos;
  else state.positions.push(pos);
  state.metrics.openPositions = state.positions.filter(p => p.status === "open").length;
  saveState(state);
  broadcast("position", pos);
  broadcast("metrics", state.metrics);
  res.json({ ok: true });
});

// POST /agent/equity  { value }
app.post("/agent/equity", (req, res) => {
  const point = { ts: new Date().toISOString(), value: req.body.value };
  state.equity.push(point);
  if (state.equity.length > 1000) state.equity = state.equity.slice(-1000);
  state.metrics.equity = req.body.value;
  saveState(state);
  broadcast("equity", point);
  broadcast("metrics", state.metrics);
  res.json({ ok: true });
});

// POST /agent/params  { ...params }
app.post("/agent/params", (req, res) => {
  state.params = { ...req.body, updatedAt: new Date().toISOString() };
  saveState(state);
  broadcast("params", state.params);
  res.json({ ok: true });
});

// ─── Dashboard read endpoints ─────────────────────────────────────────────────

app.get("/state",          (_, res) => res.json(state));
app.get("/state/trades",   (_, res) => res.json(state.trades.slice(-100)));
app.get("/state/feed",     (_, res) => res.json(state.feed.slice(-100)));
app.get("/state/positions",(_, res) => res.json(state.positions));
app.get("/state/equity",   (_, res) => res.json(state.equity));
app.get("/state/metrics",  (_, res) => res.json(state.metrics));

// Serve backtest results files
app.get("/results-list", (_, res) => {
  try {
    const files = fs.readdirSync("./results").filter(f => f.endsWith(".json"));
    res.json(files);
  } catch { res.json([]); }
});
app.get("/results/:file", (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join("./results", file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: "not found" });
  res.sendFile(path.resolve(full));
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nMission Control: http://localhost:${PORT}`);
  console.log(`SSE stream:      http://localhost:${PORT}/events`);
  console.log(`State API:       http://localhost:${PORT}/state\n`);
});
