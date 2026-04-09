/**
 * dashboard.js — Trading Agent Mission Control
 * Single-file server: serves a live dashboard + API
 *
 * Run: node dashboard.js
 * Open: http://localhost:3001
 */

import http    from "http";
import fs      from "fs";
import path    from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

const PORT     = 3001;
const RESULTS  = "./results";
const __dir    = path.dirname(fileURLToPath(import.meta.url));

// ─── Read helpers ─────────────────────────────────────────────────────────────

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function getPaperStats() {
  return readJson(path.join(RESULTS, "paper-trades.json"), { equity: 1000, trades: [], openPositions: [] });
}

function getBacktestResults() {
  if (!fs.existsSync(RESULTS)) return [];
  return fs.readdirSync(RESULTS)
    .filter(f => f.startsWith("backtest-") && f.endsWith(".json"))
    .map(f => ({ file: f, ...readJson(path.join(RESULTS, f)) }))
    .sort((a, b) => (b.file > a.file ? 1 : -1));
}

// ─── API handlers ──────────────────────────────────────────────────────────────

function apiState(res) {
  const paper   = getPaperStats();
  const backtests = getBacktestResults();
  const trades  = paper.trades || [];
  const wins    = trades.filter(t => t.win);
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0));

  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({
    equity:        paper.equity || 1000,
    initialEquity: 1000,
    openPositions: paper.openPositions || [],
    trades:        trades.slice(-50).reverse(),
    stats: {
      totalTrades:  trades.length,
      winCount:     wins.length,
      lossCount:    trades.length - wins.length,
      winRate:      trades.length ? +(wins.length / trades.length * 100).toFixed(1) : 0,
      totalPnl:     +totalPnl.toFixed(2),
      totalReturn:  +((totalPnl / 1000) * 100).toFixed(2),
      profitFactor: gl > 0 ? +(gw / gl).toFixed(2) : null,
    },
    backtests: backtests.slice(0, 5).map(b => ({
      file:        b.file,
      symbol:      b.config?.symbol,
      interval:    b.config?.interval,
      days:        b.config?.days,
      totalTrades: b.metrics?.totalTrades,
      winRate:     b.metrics?.winRate,
      totalReturn: b.metrics?.totalReturn,
      sharpe:      b.metrics?.sharpeRatio,
      maxDD:       b.metrics?.maxDrawdownPct,
    })),
  }));
}

// Run paper agent (one round) — streams log lines via SSE
const agentLogs = [];
let agentRunning = false;

function runAgent(res) {
  if (agentRunning) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Agent already running" }));
    return;
  }
  agentRunning = true;
  agentLogs.length = 0;
  agentLogs.push(`[${new Date().toISOString()}] Starting paper agent...`);

  const child = execFile("node", ["paper-agent.js"], { cwd: __dir });
  child.stdout.on("data", d => agentLogs.push(...d.toString().split("\n").filter(Boolean)));
  child.stderr.on("data", d => agentLogs.push(...d.toString().split("\n").filter(Boolean)));
  child.on("close", () => { agentRunning = false; agentLogs.push("--- run complete ---"); });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ started: true }));
}

function apiLogs(res) {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ running: agentRunning, logs: agentLogs.slice(-100) }));
}

// ─── HTML dashboard ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trading Agent — Mission Control</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a0f;color:#e2e8f0;font-family:'SF Mono',monospace;font-size:13px;min-height:100vh}
  .header{background:#111;border-bottom:1px solid #1e293b;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
  .header h1{font-size:15px;font-weight:600;color:#fff;letter-spacing:.05em}
  .header h1 span{color:#22d3ee}
  .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:6px;box-shadow:0 0 6px #22c55e}
  .dot.off{background:#ef4444;box-shadow:0 0 6px #ef4444}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;padding:20px 24px 0}
  .card{background:#111827;border:1px solid #1e293b;border-radius:8px;padding:16px}
  .card .label{color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
  .card .val{font-size:22px;font-weight:700;color:#f1f5f9}
  .card .sub{font-size:11px;color:#64748b;margin-top:3px}
  .green{color:#22c55e!important}.red{color:#ef4444!important}.yellow{color:#f59e0b!important}
  .section{padding:20px 24px}
  .section h2{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#64748b;margin-bottom:12px;border-bottom:1px solid #1e293b;padding-bottom:8px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:6px 10px;border-bottom:1px solid #1e293b}
  td{padding:8px 10px;border-bottom:1px solid #0f172a;font-size:12px}
  tr:hover td{background:#111827}
  .badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600}
  .badge.win{background:#052e16;color:#22c55e;border:1px solid #166534}
  .badge.loss{background:#2d0707;color:#ef4444;border:1px solid #7f1d1d}
  .badge.open{background:#0c1a2e;color:#38bdf8;border:1px solid #0369a1}
  .btn{background:#1d4ed8;color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;transition:background .2s}
  .btn:hover{background:#2563eb}
  .btn:disabled{background:#1e293b;color:#475569;cursor:not-allowed}
  .btn.danger{background:#7f1d1d;color:#fca5a5}.btn.danger:hover{background:#991b1b}
  .terminal{background:#030712;border:1px solid #1e293b;border-radius:8px;padding:14px;height:220px;overflow-y:auto;font-size:11px;line-height:1.6;color:#94a3b8}
  .terminal .line{white-space:pre-wrap;word-break:break-all}
  .terminal .line.agent{color:#22d3ee}
  .terminal .line.tool{color:#a78bfa}
  .terminal .line.err{color:#f87171}
  .controls{display:flex;gap:10px;align-items:center;margin-bottom:12px}
  .running{color:#f59e0b;font-size:11px;animation:pulse 1s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .pos-card{background:#0c1a2e;border:1px solid #0369a1;border-radius:6px;padding:10px 14px;margin-bottom:8px}
  .pos-card .sym{color:#38bdf8;font-weight:600}
  .pos-card .details{color:#64748b;font-size:11px;margin-top:4px}
  .empty{color:#334155;text-align:center;padding:24px;font-size:12px}
  @media(max-width:600px){.grid{grid-template-columns:1fr 1fr}.header{flex-direction:column;gap:8px;align-items:flex-start}}
</style>
</head>
<body>
<div class="header">
  <h1><span class="dot" id="dot"></span>Trading Agent — <span>Mission Control</span></h1>
  <div style="color:#475569;font-size:11px" id="updated">Loading...</div>
</div>

<div class="grid" id="metrics"></div>

<div class="section">
  <h2>Open Positions</h2>
  <div id="positions"><div class="empty">No open positions</div></div>
</div>

<div class="section">
  <h2>Paper Agent</h2>
  <div class="controls">
    <button class="btn" id="runBtn" onclick="runAgent()">Run Paper Agent</button>
    <span id="runStatus"></span>
  </div>
  <div class="terminal" id="terminal"><div class="line" style="color:#334155">— agent logs will appear here —</div></div>
</div>

<div class="section">
  <h2>Recent Trades</h2>
  <div id="trades"><div class="empty">No trades yet</div></div>
</div>

<div class="section">
  <h2>Backtest Results</h2>
  <div id="backtests"><div class="empty">No backtest results</div></div>
</div>

<script>
let lastLogCount = 0;

async function load() {
  const d = await fetch('/api/state').then(r=>r.json()).catch(()=>null);
  if (!d) return;

  document.getElementById('dot').className = 'dot';
  document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();

  // Metrics
  const ret = d.stats.totalReturn;
  document.getElementById('metrics').innerHTML = [
    metric('Equity', '$' + d.equity.toFixed(2), retColor(ret)),
    metric('Return', (ret >= 0 ? '+' : '') + ret + '%', retColor(ret)),
    metric('Trades', d.stats.totalTrades, '#f1f5f9'),
    metric('Win Rate', d.stats.winRate + '%', d.stats.winRate >= 50 ? '#22c55e' : '#ef4444'),
    metric('Total P&L', '$' + d.stats.totalPnl.toFixed(2), retColor(d.stats.totalPnl)),
    metric('Profit Factor', d.stats.profitFactor ?? '—', d.stats.profitFactor >= 1 ? '#22c55e' : '#ef4444'),
    metric('Open Pos.', d.openPositions.length, '#38bdf8'),
  ].join('');

  // Open positions
  const posEl = document.getElementById('positions');
  if (d.openPositions.length) {
    posEl.innerHTML = d.openPositions.map(p => \`
      <div class="pos-card">
        <div class="sym">\${p.symbol} <span class="badge \${p.side==='long'?'win':'loss'}">\${p.side.toUpperCase()}</span></div>
        <div class="details">Entry $\${p.entry.toFixed(2)} · Size $\${p.sizeUsd.toFixed(2)} · Stop $\${p.stop.toFixed(2)} · TP $\${p.tp.toFixed(2)}<br>Opened \${new Date(p.openedAt).toLocaleString()}</div>
      </div>\`).join('');
  } else {
    posEl.innerHTML = '<div class="empty">No open positions</div>';
  }

  // Trades table
  const trEl = document.getElementById('trades');
  if (d.trades.length) {
    trEl.innerHTML = '<table><thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&L</th><th>%</th><th>Reason</th><th>Date</th></tr></thead><tbody>' +
      d.trades.map(t => \`<tr>
        <td>\${t.symbol}</td>
        <td><span class="badge \${t.side==='long'?'win':'loss'}">\${t.side}</span></td>
        <td>$\${t.entry.toFixed(2)}</td>
        <td>$\${(t.exitPrice||0).toFixed(2)}</td>
        <td class="\${t.pnl>=0?'green':'red'}">\${t.pnl>=0?'+':''}\${t.pnl.toFixed(4)}</td>
        <td class="\${t.pnlPct>=0?'green':'red'}">\${t.pnlPct>=0?'+':''}\${t.pnlPct}%</td>
        <td style="color:#94a3b8">\${t.exitReason||'—'}</td>
        <td style="color:#475569">\${t.closedAt?new Date(t.closedAt).toLocaleDateString():''}</td>
      </tr>\`).join('') + '</tbody></table>';
  } else {
    trEl.innerHTML = '<div class="empty">No trades yet — run the paper agent to start</div>';
  }

  // Backtests
  const btEl = document.getElementById('backtests');
  if (d.backtests.length) {
    btEl.innerHTML = '<table><thead><tr><th>Symbol</th><th>Interval</th><th>Days</th><th>Trades</th><th>Win Rate</th><th>Return</th><th>Sharpe</th><th>Max DD</th></tr></thead><tbody>' +
      d.backtests.map(b => \`<tr>
        <td>\${b.symbol||'—'}</td><td>\${b.interval||'—'}</td><td>\${b.days||'—'}</td>
        <td>\${b.totalTrades??'—'}</td>
        <td class="\${(b.winRate||0)>=50?'green':'red'}">\${b.winRate??'—'}%</td>
        <td class="\${(b.totalReturn||0)>=0?'green':'red'}">\${b.totalReturn??'—'}%</td>
        <td class="\${(b.sharpe||0)>=1?'green':(b.sharpe||0)>=0?'yellow':'red'}">\${b.sharpe??'—'}</td>
        <td class="yellow">\${b.maxDD??'—'}%</td>
      </tr>\`).join('') + '</tbody></table>';
  } else {
    btEl.innerHTML = '<div class="empty">No backtest results — run: node backtest.js</div>';
  }
}

function metric(label, val, color) {
  return \`<div class="card"><div class="label">\${label}</div><div class="val" style="color:\${color}">\${val}</div></div>\`;
}
function retColor(v) { return v > 0 ? '#22c55e' : v < 0 ? '#ef4444' : '#f1f5f9'; }

async function runAgent() {
  const btn = document.getElementById('runBtn');
  btn.disabled = true;
  document.getElementById('runStatus').innerHTML = '<span class="running">Running...</span>';
  document.getElementById('terminal').innerHTML = '';
  lastLogCount = 0;
  await fetch('/api/run', { method: 'POST' }).catch(()=>{});
  pollLogs();
}

async function pollLogs() {
  const d = await fetch('/api/logs').then(r=>r.json()).catch(()=>null);
  if (!d) return;
  const term = document.getElementById('terminal');
  const newLines = d.logs.slice(lastLogCount);
  lastLogCount = d.logs.length;
  for (const line of newLines) {
    const div = document.createElement('div');
    div.className = 'line' + (line.startsWith('[agent]') ? ' agent' : line.startsWith('[tool]') ? ' tool' : line.includes('error') || line.includes('Error') ? ' err' : '');
    div.textContent = line;
    term.appendChild(div);
  }
  term.scrollTop = term.scrollHeight;

  if (d.running) {
    setTimeout(pollLogs, 1000);
  } else {
    document.getElementById('runBtn').disabled = false;
    document.getElementById('runStatus').textContent = '';
    load();
  }
}

// Auto-refresh every 15s
load();
setInterval(load, 15000);
</script>
</body>
</html>`;

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/state") return apiState(res);
  if (url === "/api/logs")  return apiLogs(res);
  if (url === "/api/run" && req.method === "POST") return runAgent(res);

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Trading Agent Mission Control → http://localhost:${PORT}`);
});
