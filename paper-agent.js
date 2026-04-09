/**
 * paper-agent.js — Paper trading simulator
 *
 * Runs the full Claude agent loop with:
 *   - Real public market data (Bybit public API, no auth needed)
 *   - Simulated wallet (no real orders placed)
 *   - Stop-loss / take-profit tracking per position
 *   - Persistent trade log in results/paper-trades.json
 *
 * Run:
 *   node paper-agent.js
 *   node paper-agent.js "Scan ETH and BTC. Check funding arb, then score signals."
 *   node paper-agent.js --equity 5000   (start with $5000 paper balance)
 *   node paper-agent.js --rounds 5      (run 5 agent cycles back-to-back)
 */

import fs       from "fs";
import path     from "path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI   from "openai";

// Load .env
try {
  fs.readFileSync(".env", "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}
import { STRATEGY_SYSTEM_PROMPT, riskCheck, loadState } from "./strategy.js";
import { loadParams } from "./adaptive.js";
import { reporter } from "./reporter.js";

// ─── Provider detection ───────────────────────────────────────────────────────
// Uses Moonshot if MOONSHOT_API_KEY is set, otherwise falls back to Anthropic.

const PROVIDER = process.env.MOONSHOT_API_KEY ? "moonshot" : "anthropic";
const MODEL    = PROVIDER === "moonshot" ? "moonshot-v1-32k" : "claude-opus-4-6";

console.log(`[provider] ${PROVIDER} | model: ${MODEL}`);

// ─── CLI args ─────────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const flags   = {};
const taskParts = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i].startsWith("--")) { flags[rawArgs[i].slice(2)] = rawArgs[i+1]; i++; }
  else taskParts.push(rawArgs[i]);
}

const INITIAL_EQUITY = parseFloat(flags.equity || 1000);
const MAX_ROUNDS     = parseInt(flags.rounds || 1);
const LOG_PATH       = "./results/paper-trades.json";

const DEFAULT_TASK = "Scan ETHUSDT and BTCUSDT. Check funding arb first, then score directional signals on both. Use current strategy params. Report your decision with score, entry, stop, TP, and R/R ratio.";
const TASK = taskParts.length ? taskParts.join(" ") : DEFAULT_TASK;

// ─── Paper wallet ─────────────────────────────────────────────────────────────

function loadLedger() {
  if (!fs.existsSync(LOG_PATH)) {
    return { equity: INITIAL_EQUITY, trades: [], openPositions: [] };
  }
  return JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.writeFileSync(LOG_PATH, JSON.stringify(ledger, null, 2));
}

let ledger = loadLedger();
// Reset equity only on first run
if (!fs.existsSync(LOG_PATH)) {
  ledger.equity = INITIAL_EQUITY;
  saveLedger(ledger);
}

// ─── Public market data (no auth) ────────────────────────────────────────────

const PUB_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Accept": "application/json",
};

async function pubGet(path_, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `https://api.bybit.com${path_}${qs ? "?" + qs : ""}`;
  const res  = await fetch(url, { headers: PUB_HEADERS });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Bybit returned non-JSON (likely geo-blocked)"); }
  if (data.retCode !== 0) throw new Error(`Bybit: ${data.retMsg}`);
  return data.result;
}

// Fallback: CoinGecko spot price
const CG_IDS = { ETHUSDT: "ethereum", BTCUSDT: "bitcoin", SOLUSDT: "solana", BNBUSDT: "binancecoin" };
async function cgPrice(symbol) {
  const id  = CG_IDS[symbol] || "ethereum";
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
  const res  = await fetch(url, { headers: PUB_HEADERS });
  const data = await res.json();
  return data[id]?.usd || null;
}

// ─── Paper tool implementations ───────────────────────────────────────────────

async function paperGetTicker({ symbol }) {
  const sym = symbol.toUpperCase().replace("/", "");
  try {
    const r = await pubGet("/v5/market/tickers", { category: "spot", symbol: sym });
    const t = r.list?.[0];
    if (!t) throw new Error("no ticker");
    return [
      `[PAPER] ${sym} ticker`,
      `  Last:    $${parseFloat(t.lastPrice).toFixed(2)}`,
      `  Bid/Ask: $${parseFloat(t.bid1Price).toFixed(2)} / $${parseFloat(t.ask1Price).toFixed(2)}`,
      `  24h chg: ${(parseFloat(t.price24hPcnt) * 100).toFixed(2)}%`,
      `  24h vol: ${parseFloat(t.volume24h).toLocaleString()} ${sym.replace("USDT","")}`,
    ].join("\n");
  } catch {
    // Fallback to CoinGecko
    const price = await cgPrice(sym);
    if (!price) return `[PAPER] ${sym}: price unavailable`;
    return `[PAPER] ${sym}\n  Last: $${price.toFixed(2)}\n  Source: CoinGecko (Bybit unavailable)`;
  }
}

async function paperAnalyzeChart({ symbol, interval = "D", period = 14 }) {
  const sym   = symbol.toUpperCase().replace("/", "");
  let closes;

  try {
    const r     = await pubGet("/v5/market/kline", { category: "spot", symbol: sym, interval, limit: period + 1 });
    closes = r.list.map(c => parseFloat(c[4])).reverse();
  } catch {
    // CoinGecko OHLC fallback (daily only)
    const id  = CG_IDS[sym] || "ethereum";
    const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=30`;
    const res  = await fetch(url, { headers: PUB_HEADERS });
    const data = await res.json();
    if (!Array.isArray(data)) return `[PAPER] ${sym}: chart data unavailable`;
    closes = data.slice(-period - 1).map(c => c[4]);
  }

  if (closes.length < 2) return `[PAPER] ${sym}: not enough candle data`;

  const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const ag = gains / (closes.length - 1), al = losses / (closes.length - 1);
  const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  const last = closes[closes.length - 1];

  return [
    `[PAPER] ${sym} | interval: ${interval} | period: ${period}`,
    `Last close: $${last.toFixed(2)}`,
    `SMA(${period}): $${sma.toFixed(2)} — ${last > sma ? "above SMA (bullish bias)" : "below SMA (bearish bias)"}`,
    `RSI(${period}): ${rsi.toFixed(1)}${rsi < 30 ? " ← oversold" : rsi > 70 ? " ← overbought" : ""}`,
  ].join("\n");
}

function paperGetBalance({ coin = "USDT" }) {
  const reserved = ledger.openPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
  const available = Math.max(0, ledger.equity - reserved);
  const lines = [
    `[PAPER WALLET] ${coin} balance`,
    `  Total equity:  $${ledger.equity.toFixed(2)}`,
    `  In positions:  $${reserved.toFixed(2)}`,
    `  Available:     $${available.toFixed(2)}`,
    `  Open positions: ${ledger.openPositions.length}`,
  ];
  if (ledger.openPositions.length > 0) {
    for (const p of ledger.openPositions) {
      lines.push(`    • ${p.side.toUpperCase()} ${p.symbol} $${p.sizeUsd} @ $${p.entry.toFixed(2)} | stop $${p.stop.toFixed(2)} | tp $${p.tp.toFixed(2)}`);
    }
  }
  return lines.join("\n");
}

async function paperPlaceOrder({ symbol, side, qty, orderType = "Market", price }) {
  const sym = symbol.toUpperCase().replace("/", "");

  // Get live fill price
  let fillPrice = price;
  if (!fillPrice) {
    try {
      const r = await pubGet("/v5/market/tickers", { category: "spot", symbol: sym });
      fillPrice = parseFloat(r.list?.[0]?.lastPrice || "0");
    } catch {
      fillPrice = await cgPrice(sym);
    }
  }
  if (!fillPrice) return `[PAPER] Order failed: could not get price for ${sym}`;

  const SLIPPAGE = 0.0005; // 0.05%
  const FEE      = 0.0006; // 0.06% taker
  const isBuy    = side.toLowerCase() === "buy";
  const execPrice = fillPrice * (1 + (isBuy ? 1 : -1) * SLIPPAGE);
  const sizeUsd  = qty * execPrice;
  const feeCost  = sizeUsd * FEE;

  if (sizeUsd > 100) {
    return `[PAPER] Order REJECTED — size $${sizeUsd.toFixed(2)} exceeds $100 limit. Reduce qty.`;
  }

  const reserved = ledger.openPositions.reduce((s, p) => s + p.sizeUsd, 0);
  if (sizeUsd + feeCost > ledger.equity - reserved) {
    return `[PAPER] Order REJECTED — insufficient funds. Available: $${(ledger.equity - reserved).toFixed(2)}`;
  }

  // Default stop/TP (3% / 6%) — agent can specify via follow-up set_sl_tp tool
  const stopPct = 0.03, tpPct = 0.06;
  const stop = isBuy ? execPrice * (1 - stopPct) : execPrice * (1 + stopPct);
  const tp   = isBuy ? execPrice * (1 + tpPct)   : execPrice * (1 - tpPct);

  const orderId = `PAPER-${Date.now()}`;
  const position = {
    id:       orderId,
    symbol:   sym,
    side:     isBuy ? "long" : "short",
    entry:    execPrice,
    qty,
    sizeUsd,
    stop,
    tp,
    openedAt: new Date().toISOString(),
    feePaid:  feeCost,
  };

  ledger.openPositions.push(position);
  ledger.equity -= feeCost; // deduct entry fee immediately
  saveLedger(ledger);

  return [
    `[PAPER] Order filled (simulated)`,
    `  orderId:  ${orderId}`,
    `  symbol:   ${sym}`,
    `  side:     ${side.toUpperCase()}`,
    `  qty:      ${qty}`,
    `  fillPrice: $${execPrice.toFixed(2)}  (slippage: ${(SLIPPAGE*100).toFixed(3)}%)`,
    `  sizeUsd:  $${sizeUsd.toFixed(2)}`,
    `  fee:      $${feeCost.toFixed(4)}`,
    `  stop:     $${stop.toFixed(2)} (-${(stopPct*100).toFixed(1)}%)`,
    `  TP:       $${tp.toFixed(2)} (+${(tpPct*100).toFixed(1)}%)`,
    `  Wallet after fee: $${ledger.equity.toFixed(2)}`,
  ].join("\n");
}

// ─── Check open positions against current price ───────────────────────────────

async function checkOpenPositions() {
  if (!ledger.openPositions.length) return;
  const closed = [];

  for (const pos of ledger.openPositions) {
    let price;
    try {
      const r = await pubGet("/v5/market/tickers", { category: "spot", symbol: pos.symbol });
      price = parseFloat(r.list?.[0]?.lastPrice || "0");
    } catch {
      price = await cgPrice(pos.symbol);
    }
    if (!price) continue;

    const isLong = pos.side === "long";
    let exitReason = null;
    let exitPrice  = price;

    if (isLong && price <= pos.stop)  { exitReason = "stop_loss";   exitPrice = pos.stop; }
    if (isLong && price >= pos.tp)    { exitReason = "take_profit"; exitPrice = pos.tp;   }
    if (!isLong && price >= pos.stop) { exitReason = "stop_loss";   exitPrice = pos.stop; }
    if (!isLong && price <= pos.tp)   { exitReason = "take_profit"; exitPrice = pos.tp;   }

    if (exitReason) {
      const FEE = 0.0006;
      const raw = isLong
        ? (exitPrice - pos.entry) * pos.qty
        : (pos.entry - exitPrice) * pos.qty;
      const exitFee = pos.sizeUsd * FEE;
      const pnl = raw - exitFee;

      ledger.equity += pos.sizeUsd + pnl; // return capital + PnL
      const trade = {
        ...pos, exitPrice, pnl: +pnl.toFixed(4), pnlPct: +((pnl / pos.sizeUsd) * 100).toFixed(2),
        exitReason, closedAt: new Date().toISOString(), win: pnl > 0,
      };
      ledger.trades.push(trade);
      closed.push(trade);
      console.log(`\n[paper] POSITION CLOSED — ${pos.symbol} ${pos.side.toUpperCase()} | ${exitReason} | PnL: $${pnl.toFixed(4)} (${trade.pnlPct}%)`);
      reporter.trade({ ...trade, venue: "paper" });
      reporter.equity(ledger.equity);
      reporter.feed(`Closed ${pos.symbol} ${pos.side} | ${exitReason} | PnL: $${pnl.toFixed(4)} (${trade.pnlPct}%)`, pnl >= 0 ? "buy" : "sell");
    }
  }

  ledger.openPositions = ledger.openPositions.filter(p => !closed.find(c => c.id === p.id));
  if (closed.length) saveLedger(ledger);
}

// ─── Paper tool dispatcher ────────────────────────────────────────────────────

async function executePaperTool(name, input) {
  try {
    switch (name) {
      case "get_ticker":     return await paperGetTicker(input);
      case "analyze_chart":  return await paperAnalyzeChart(input);
      case "get_balance":    return paperGetBalance(input);
      case "place_order":    return await paperPlaceOrder(input);
      // DEX tools — stub with paper equivalents
      case "hl_get_market":
      case "hl_get_funding": return `[PAPER] ${name} — simulated. Use get_ticker for live prices.`;
      case "hl_place_perp":
      case "hl_place_spot":  return await paperPlaceOrder({ ...input, symbol: input.coin || input.symbol || "ETHUSDT" });
      default:               return `[PAPER] Tool ${name} not available in paper mode.`;
    }
  } catch (err) {
    return `[PAPER] Tool error (${name}): ${err.message}`;
  }
}

// ─── Tool definitions (same schema as live, passed to Claude) ─────────────────

const PAPER_TOOL_DEFS = [
  {
    name: "get_ticker",
    description: "Get current price and 24h stats for a spot pair (paper trading — uses real public data)",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "e.g. ETHUSDT" } },
      required: ["symbol"],
    },
  },
  {
    name: "analyze_chart",
    description: "Fetch recent candles and compute SMA + RSI (paper trading — real public data)",
    input_schema: {
      type: "object",
      properties: {
        symbol:   { type: "string" },
        interval: { type: "string", description: "D=daily, 60=1h, 15=15m", default: "D" },
        period:   { type: "number", default: 14 },
      },
      required: ["symbol"],
    },
  },
  {
    name: "get_balance",
    description: "Check paper wallet balance and open positions",
    input_schema: {
      type: "object",
      properties: { coin: { type: "string", default: "USDT" } },
      required: [],
    },
  },
  {
    name: "place_order",
    description: "Simulate placing a spot buy/sell order. Max $100 per position. Orders fill at live market price.",
    input_schema: {
      type: "object",
      properties: {
        symbol:    { type: "string" },
        side:      { type: "string", enum: ["buy", "sell"] },
        qty:       { type: "number", description: "Quantity in base coin" },
        orderType: { type: "string", enum: ["Market", "Limit"], default: "Market" },
        price:     { type: "number", description: "Required for Limit orders" },
      },
      required: ["symbol", "side", "qty"],
    },
  },
];

// ─── Performance summary ──────────────────────────────────────────────────────

function printSummary() {
  const trades = ledger.trades;
  if (!trades.length) { console.log("\n[paper] No completed trades yet."); return; }

  const wins   = trades.filter(t => t.win);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const profitFactor = (() => {
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(trades.filter(t => !t.win).reduce((s, t) => s + t.pnl, 0));
    return gl > 0 ? (gw / gl).toFixed(2) : "∞";
  })();

  console.log(`\n${"═".repeat(55)}`);
  console.log("PAPER TRADING SUMMARY");
  console.log("═".repeat(55));
  console.log(`Total trades    : ${trades.length}`);
  console.log(`Win / Loss      : ${wins.length} / ${trades.length - wins.length}`);
  console.log(`Win rate        : ${trades.length ? (wins.length / trades.length * 100).toFixed(1) : 0}%`);
  console.log(`Total P&L       : $${totalPnl.toFixed(2)}`);
  console.log(`Profit factor   : ${profitFactor}`);
  console.log(`Current equity  : $${ledger.equity.toFixed(2)}  (started $${INITIAL_EQUITY})`);
  console.log(`Return          : ${((ledger.equity - INITIAL_EQUITY) / INITIAL_EQUITY * 100).toFixed(2)}%`);
  console.log(`Open positions  : ${ledger.openPositions.length}`);
  if (ledger.openPositions.length) {
    for (const p of ledger.openPositions) {
      console.log(`  • ${p.side.toUpperCase()} ${p.symbol} $${p.sizeUsd.toFixed(2)} @ $${p.entry.toFixed(2)}`);
    }
  }
  console.log(`Log             : ${LOG_PATH}`);
  console.log("═".repeat(55));
}

// ─── Main agent loop ──────────────────────────────────────────────────────────

// ─── Tool definitions: Anthropic format ──────────────────────────────────────

function anthropicTools() {
  return PAPER_TOOL_DEFS.map(t => ({ ...t, type: "custom" }));
}

// ─── Tool definitions: OpenAI / Moonshot format ───────────────────────────────

function openaiTools() {
  return PAPER_TOOL_DEFS.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// ─── Provider-agnostic agent loop ────────────────────────────────────────────

async function runPaperRound(task, roundNum) {
  const params = loadParams();
  console.log(`\n${"─".repeat(55)}`);
  console.log(`[paper] Round ${roundNum} | ${PROVIDER} | threshold: ${params.tradeThreshold}`);
  console.log(`[paper] Task: ${task.slice(0, 80)}...`);
  console.log(`[paper] Equity: $${ledger.equity.toFixed(2)}`);
  console.log("─".repeat(55));

  await checkOpenPositions();
  loadState({ equityPeak: ledger.equity, dailyStartEq: ledger.equity, dailyResetAt: null, paused: false });
  reporter.status("running", task);
  reporter.equity(ledger.equity);

  const PAPER_SYSTEM = STRATEGY_SYSTEM_PROMPT +
    "\n\nIMPORTANT: You are in PAPER TRADING mode. All orders are simulated — no real money at risk. " +
    "Use place_order freely to test your strategy. The paper wallet tracks your simulated P&L.";

  if (PROVIDER === "moonshot") {
    await runOpenAILoop(task, PAPER_SYSTEM);
  } else {
    await runAnthropicLoop(task, PAPER_SYSTEM);
  }
}

async function runAnthropicLoop(task, systemPrompt) {
  const client   = new Anthropic();
  const messages = [{ role: "user", content: task }];
  let iteration  = 0;

  while (iteration < 12) {
    iteration++;
    const response = await client.messages.create({
      model: MODEL, max_tokens: 4096,
      system: systemPrompt, tools: anthropicTools(), messages,
    });

    for (const b of response.content)
      if (b.type === "text" && b.text.trim()) console.log("[agent]", b.text);

    const toolUses = response.content.filter(b => b.type === "tool_use");
    if (!toolUses.length || response.stop_reason === "end_turn") break;

    messages.push({ role: "assistant", content: response.content });
    const results = [];
    for (const tu of toolUses) {
      const result = await executePaperTool(tu.name, tu.input);
      console.log(`[tool] ${tu.name} →`, result.slice(0, 160));
      reporter.feed(`[${tu.name}] ${result.slice(0, 120)}`, "tool");
      if (tu.name === "place_order") {
        reporter.feed(`Paper trade: ${tu.input.side?.toUpperCase()} ${tu.input.symbol}`, result.includes("REJECTED") ? "error" : "buy");
        reporter.equity(ledger.equity);
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: results });
  }
}

async function runOpenAILoop(task, systemPrompt) {
  const client = new OpenAI({
    apiKey:  process.env.MOONSHOT_API_KEY,
    baseURL: "https://api.moonshot.ai/v1",
  });

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: task },
  ];
  let iteration = 0;

  while (iteration < 12) {
    iteration++;
    const response = await client.chat.completions.create({
      model: MODEL, max_tokens: 4096,
      tools: openaiTools(), tool_choice: "auto", messages,
    });

    const msg = response.choices[0].message;
    if (msg.content) { console.log("[agent]", msg.content); reporter.feed(msg.content, "sys"); }

    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length || response.choices[0].finish_reason === "stop") break;

    messages.push(msg);
    for (const tc of toolCalls) {
      let input;
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      const result = await executePaperTool(tc.function.name, input);
      console.log(`[tool] ${tc.function.name} →`, result.slice(0, 160));
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
}

async function main() {
  console.log(`\n${"═".repeat(55)}`);
  console.log("PAPER TRADING AGENT");
  console.log(`Starting equity: $${ledger.equity.toFixed(2)} | Rounds: ${MAX_ROUNDS}`);
  console.log("═".repeat(55));

  for (let i = 1; i <= MAX_ROUNDS; i++) {
    await runPaperRound(TASK, i);
    if (i < MAX_ROUNDS) await new Promise(r => setTimeout(r, 2000));
  }

  printSummary();
}

main().catch(console.error);
