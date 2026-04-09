/**
 * backtest.js
 * Walk-forward backtesting harness for strategy.js
 *
 * Fetches real OHLCV history from Bybit (no auth needed for market data).
 * Simulates trades candle-by-candle with zero lookahead bias.
 * Outputs full metrics + per-trade log to results/backtest-<timestamp>.json
 *
 * Run:
 *   node backtest.js --symbol ETHUSDT --interval D --days 365
 *   node backtest.js --symbol BTCUSDT --interval 60 --days 90   (1h candles, 90 days)
 *   node backtest.js --csv ./data/ETHUSDT_1D.csv               (use local CSV)
 *
 * CSV format expected: timestamp,open,high,low,close,volume  (unix ms or ISO date)
 */

import fs   from "fs";
import path from "path";
import { scoreSignals, calcPositionSize, scanFundingArb, riskCheck, loadState, getState } from "./strategy.js";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => {
    if (v.startsWith("--")) acc.push([v.slice(2), a[i+1] ?? true]);
    return acc;
  }, [])
);

const SYMBOL   = (args.symbol   || "ETHUSDT").toUpperCase();
const INTERVAL = args.interval  || "D";       // D | 60 | 15 | 240
const DAYS     = parseInt(args.days || 365);
const CSV_PATH = args.csv       || null;
const INITIAL_EQUITY = parseFloat(args.equity || 1000);
const SLIPPAGE_PCT   = parseFloat(args.slippage || 0.05) / 100;  // 0.05% default
const FEE_PCT        = parseFloat(args.fee      || 0.06) / 100;  // 0.06% taker fee

// ─── Data fetching: Bybit → CoinGecko → synthetic fallback ──────────────────

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Accept":     "application/json",
};

async function fetchBybitKlines(symbol, interval, limit) {
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res  = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("bybit_html"); }
  if (data.retCode !== 0) throw new Error(`Bybit: ${data.retMsg}`);
  return data.result.list
    .map(c => ({ ts: parseInt(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
                 low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]) }))
    .reverse();
}

const CG_IDS = { ETHUSDT:"ethereum", BTCUSDT:"bitcoin", SOLUSDT:"solana",
                 MATICUSDT:"matic-network", ARBUSDT:"arbitrum", BNBUSDT:"binancecoin" };

async function fetchCoinGeckoCandles(symbol, days) {
  const id  = CG_IDS[symbol] || "ethereum";
  const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=${Math.min(days,365)}`;
  const res  = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("coingecko_html"); }
  if (!Array.isArray(data)) throw new Error(`CoinGecko: ${JSON.stringify(data).slice(0,80)}`);
  return data.map(c => ({ ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: 0 }));
}

function generateSyntheticCandles(symbol, days) {
  const BASE = { ETHUSDT:2000, BTCUSDT:45000, SOLUSDT:100, MATICUSDT:0.8 };
  let price = BASE[symbol] || 2000;
  const candles = [];
  const now = Date.now();
  for (let i = days; i >= 0; i--) {
    price = Math.max(1, price * (1 + (Math.random()-0.48)*0.03));
    const range = price * (0.01 + Math.random()*0.03);
    const open  = price * (1 + (Math.random()-0.5)*0.005);
    candles.push({ ts: now - i*86400000, open, high: Math.max(open,price)+range*Math.random(),
                   low: Math.min(open,price)-range*Math.random(), close: price, volume: price*2000 });
  }
  return candles;
}

async function fetchCandles(symbol, interval, days) {
  const limit = Math.min(1000, days * (interval === "D" ? 1 : Math.round(24*60/parseInt(interval))));
  try {
    console.log(`Fetching ${Math.round(limit)} candles from Bybit...`);
    const c = await fetchBybitKlines(symbol, interval, Math.round(limit));
    console.log("Source: Bybit"); return c;
  } catch(e) { console.log(`Bybit unavailable (${e.message}) — trying CoinGecko...`); }
  try {
    const c = await fetchCoinGeckoCandles(symbol, days);
    console.log(`Source: CoinGecko (${c.length} candles)`); return c;
  } catch(e) { console.log(`CoinGecko unavailable — using synthetic data`); }
  const c = generateSyntheticCandles(symbol, days);
  console.log("Source: synthetic"); return c;
}

// ─── Load CSV ─────────────────────────────────────────────────────────────────

function loadCSV(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  const header = lines[0].toLowerCase().split(",");
  const tsCol = ["timestamp","time","date"].reduce((found, name) => {
    const i = header.indexOf(name); return (found === -1 && i !== -1) ? i : found;
  }, -1);
  const idx = { ts: tsCol !== -1 ? tsCol : 0, open: header.indexOf("open"),
                high: header.indexOf("high"), low: header.indexOf("low"),
                close: header.indexOf("close"), volume: header.indexOf("volume") };
  return lines.slice(1).map(line => {
    const c = line.split(",");
    const tsRaw = c[idx.ts];
    const ts = isNaN(tsRaw) ? new Date(tsRaw).getTime() : parseInt(tsRaw);
    return { ts, open: +c[idx.open], high: +c[idx.high], low: +c[idx.low],
             close: +c[idx.close], volume: +c[idx.volume] };
  });
}

// ─── Technical indicators ─────────────────────────────────────────────────────

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i-1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcVolSpike(volumes, period = 14) {
  if (volumes.length < period + 1) return false;
  const avg = volumes.slice(-period - 1, -1).reduce((a,b) => a+b, 0) / period;
  return volumes[volumes.length - 1] > avg * 1.5;
}

// Simulated news sentiment: random walk biased by price momentum
// In production, replace with real web_search calls or a sentiment API
function simulateSentiment(closes, i) {
  const momentum = i > 5
    ? (closes[i] - closes[i - 5]) / closes[i - 5]
    : 0;
  // Add noise
  const noise = (Math.random() - 0.5) * 0.4;
  return Math.max(-1, Math.min(1, momentum * 10 + noise));
}

// Simulated funding rate: oscillates around 0 with occasional spikes
function simulateFunding(i) {
  return 0.01 * Math.sin(i / 20) + (Math.random() - 0.45) * 0.02;
}

// ─── Position tracker ─────────────────────────────────────────────────────────

class Position {
  constructor({ side, entry, size, stopPrice, tpPrice, openedAt, score, strategy }) {
    this.side       = side;
    this.entry      = entry;
    this.size       = size;       // USD value
    this.qty        = size / entry;
    this.stopPrice  = stopPrice;
    this.tpPrice    = tpPrice;
    this.openedAt   = openedAt;
    this.score      = score;
    this.strategy   = strategy;
    this.closed     = false;
    this.closedAt   = null;
    this.exitPrice  = null;
    this.pnl        = null;
    this.pnlPct     = null;
    this.exitReason = null;
  }

  check(candle) {
    if (this.closed) return;
    const { high, low, close, ts } = candle;

    if (this.side === "long") {
      if (low <= this.stopPrice)  { this.close(this.stopPrice, ts, "stop_loss"); return; }
      if (high >= this.tpPrice)   { this.close(this.tpPrice,   ts, "take_profit"); return; }
    } else {
      if (high >= this.stopPrice) { this.close(this.stopPrice, ts, "stop_loss"); return; }
      if (low  <= this.tpPrice)   { this.close(this.tpPrice,   ts, "take_profit"); return; }
    }
    // End-of-data close
    this.exitPrice  = close;
    this.closedAt   = ts;
    // Don't actually close here — let the loop handle end-of-data
  }

  close(price, ts, reason) {
    this.closed     = true;
    this.closedAt   = ts;
    this.exitPrice  = price * (1 + (this.side === "long" ? -1 : 1) * SLIPPAGE_PCT); // slippage on exit
    this.exitReason = reason;
    const raw = this.side === "long"
      ? (this.exitPrice - this.entry) * this.qty
      : (this.entry - this.exitPrice) * this.qty;
    const fees  = this.size * FEE_PCT * 2; // entry + exit fee
    this.pnl    = raw - fees;
    this.pnlPct = (this.pnl / this.size) * 100;
  }

  closeAtPrice(price, ts) { this.close(price, ts, "end_of_data"); }
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

async function runBacktest(candles) {
  let equity    = INITIAL_EQUITY;
  let openPos   = null;
  const trades  = [];
  const equity_curve = [{ ts: candles[0].ts, equity }];

  // Risk state
  loadState({ equityPeak: equity, dailyStartEq: equity, dailyResetAt: null, paused: false });

  const WARMUP = 20; // candles needed for indicators

  for (let i = WARMUP; i < candles.length; i++) {
    const c       = candles[i];
    const closes  = candles.slice(0, i + 1).map(x => x.close);
    const volumes = candles.slice(0, i + 1).map(x => x.volume);

    // ── Check open position ──────────────────────────────────────────────────
    if (openPos && !openPos.closed) {
      openPos.check(c);
      if (openPos.closed) {
        equity += openPos.pnl;
        trades.push({ ...openPos });
        openPos = null;
        equity_curve.push({ ts: c.ts, equity });
      }
    }

    if (openPos) continue; // one position at a time

    // ── Compute signals ──────────────────────────────────────────────────────
    const rsi        = calcRSI(closes);
    const sma        = calcSMA(closes, 14);
    const priceVsSma = sma ? ((c.close - sma) / sma) * 100 : 0;
    const volSpike   = calcVolSpike(volumes);
    const sentiment  = simulateSentiment(closes, i);
    const funding    = simulateFunding(i);

    if (!rsi || !sma) continue;

    // ── Risk check ───────────────────────────────────────────────────────────
    const risk = riskCheck(equity);
    if (!risk.allowed) continue;

    // ── Funding arb check ────────────────────────────────────────────────────
    const arbRates = { hl: funding };
    const arb = scanFundingArb(arbRates);
    if (arb && arb[0].executable) {
      // Arb: treat as a 1-candle hold earning the funding yield
      const size     = Math.min(equity * 0.1, 100);
      const arbPnl   = size * arb[0].dailyYield * (INTERVAL === "D" ? 1 : parseInt(INTERVAL) / 1440);
      const fee      = size * FEE_PCT * 2;
      const netPnl   = arbPnl - fee;
      equity += netPnl;
      trades.push({
        side: "arb", entry: c.close, exitPrice: c.close,
        size, pnl: netPnl, pnlPct: (netPnl/size)*100,
        score: 85, strategy: "funding_arb",
        openedAt: c.ts, closedAt: c.ts, exitReason: "funding_arb",
        closed: true,
      });
      equity_curve.push({ ts: c.ts, equity });
      continue;
    }

    // ── Score directional trade ───────────────────────────────────────────────
    for (const side of ["long", "short"]) {
      const { score, recommendation } = scoreSignals({
        rsi, priceVsSma, fundingRate: funding,
        volumeSpike: volSpike, newsSentiment: sentiment,
        side, venueFee: FEE_PCT * 100,
      });

      if (recommendation === "SKIP") continue;

      const sizing = calcPositionSize(score, equity);
      const entry  = c.close * (1 + (side === "long" ? 1 : -1) * SLIPPAGE_PCT);
      const stop   = side === "long" ? entry * (1 - sizing.stopPct) : entry * (1 + sizing.stopPct);
      const tp     = side === "long" ? entry * (1 + sizing.tpPct)   : entry * (1 - sizing.tpPct);

      openPos = new Position({
        side, entry, size: sizing.sizeUsd, stopPrice: stop, tpPrice: tp,
        openedAt: c.ts, score,
        strategy: score >= 80 ? "strong_signal" : "composite_signal",
      });
      break; // one signal per candle
    }
  }

  // Close any open position at last candle
  if (openPos && !openPos.closed) {
    const last = candles[candles.length - 1];
    openPos.closeAtPrice(last.close, last.ts);
    equity += openPos.pnl;
    trades.push({ ...openPos });
  }
  equity_curve.push({ ts: candles[candles.length - 1].ts, equity });

  return { trades, equity_curve, finalEquity: equity };
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

function calcMetrics(trades, equity_curve, initialEquity) {
  const closed  = trades.filter(t => t.closed);
  const wins    = closed.filter(t => t.pnl > 0);
  const losses  = closed.filter(t => t.pnl <= 0);
  const byStrat = {};

  for (const t of closed) {
    if (!byStrat[t.strategy]) byStrat[t.strategy] = { trades:0, wins:0, pnl:0 };
    byStrat[t.strategy].trades++;
    if (t.pnl > 0) byStrat[t.strategy].wins++;
    byStrat[t.strategy].pnl += t.pnl;
  }

  const totalPnl    = closed.reduce((a,t) => a + t.pnl, 0);
  const grossWin    = wins.reduce((a,t) => a + t.pnl, 0);
  const grossLoss   = Math.abs(losses.reduce((a,t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  // Max drawdown
  let peak = initialEquity, maxDD = 0;
  for (const p of equity_curve) {
    if (p.equity > peak) peak = p.equity;
    const dd = (peak - p.equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe (annualised, daily returns assumed for daily candles)
  const returns = equity_curve.slice(1).map((p,i) =>
    (p.equity - equity_curve[i].equity) / equity_curve[i].equity
  );
  const avgR  = returns.reduce((a,b) => a+b, 0) / returns.length;
  const stdR  = Math.sqrt(returns.map(r => (r-avgR)**2).reduce((a,b)=>a+b,0) / returns.length);
  const sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(252) : 0;

  return {
    totalTrades:    closed.length,
    winCount:       wins.length,
    lossCount:      losses.length,
    winRate:        closed.length ? +(wins.length / closed.length * 100).toFixed(1) : 0,
    totalPnl:       +totalPnl.toFixed(2),
    totalReturn:    +((totalPnl / initialEquity) * 100).toFixed(2),
    avgWin:         wins.length   ? +(grossWin   / wins.length).toFixed(2)   : 0,
    avgLoss:        losses.length ? +(grossLoss  / losses.length).toFixed(2) : 0,
    profitFactor:   +profitFactor.toFixed(2),
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    sharpeRatio:    +sharpe.toFixed(2),
    byStrategy:     byStrat,
    exitReasons: {
      take_profit: closed.filter(t => t.exitReason === "take_profit").length,
      stop_loss:   closed.filter(t => t.exitReason === "stop_loss").length,
      funding_arb: closed.filter(t => t.exitReason === "funding_arb").length,
      end_of_data: closed.filter(t => t.exitReason === "end_of_data").length,
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Backtest: ${SYMBOL} | interval: ${INTERVAL} | ${DAYS} days`);
  console.log(`Initial equity: $${INITIAL_EQUITY} | slippage: ${SLIPPAGE_PCT*100}% | fee: ${FEE_PCT*100}%`);
  console.log("─".repeat(60));

  let candles;
  if (CSV_PATH) {
    console.log(`Loading CSV: ${CSV_PATH}`);
    candles = loadCSV(CSV_PATH);
  } else {
    candles = await fetchCandles(SYMBOL, INTERVAL, DAYS);
  }

  console.log(`Loaded ${candles.length} candles`);
  console.log(`Period: ${new Date(candles[0].ts).toISOString().slice(0,10)} → ${new Date(candles[candles.length-1].ts).toISOString().slice(0,10)}`);

  const { trades, equity_curve, finalEquity } = await runBacktest(candles);
  const metrics = calcMetrics(trades, equity_curve, INITIAL_EQUITY);

  // ── Print summary ────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("RESULTS");
  console.log("═".repeat(60));
  console.log(`Total trades   : ${metrics.totalTrades}`);
  console.log(`Win / Loss     : ${metrics.winCount} / ${metrics.lossCount}`);
  console.log(`Win rate       : ${metrics.winRate}%`);
  console.log(`Total P&L      : $${metrics.totalPnl}  (${metrics.totalReturn}%)`);
  console.log(`Avg win        : $${metrics.avgWin}`);
  console.log(`Avg loss       : $${metrics.avgLoss}`);
  console.log(`Profit factor  : ${metrics.profitFactor}`);
  console.log(`Max drawdown   : ${metrics.maxDrawdownPct}%`);
  console.log(`Sharpe ratio   : ${metrics.sharpeRatio}`);
  console.log(`Final equity   : $${finalEquity.toFixed(2)}`);
  console.log("\nBy strategy:");
  for (const [k, v] of Object.entries(metrics.byStrategy)) {
    const wr = v.trades ? (v.wins/v.trades*100).toFixed(0) : 0;
    console.log(`  ${k.padEnd(20)} trades: ${v.trades} | win rate: ${wr}% | P&L: $${v.pnl.toFixed(2)}`);
  }

  // ── Save results ─────────────────────────────────────────────────────────
  const outDir = "./results";
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const outFile = path.join(outDir, `backtest-${SYMBOL}-${INTERVAL}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    config: { symbol: SYMBOL, interval: INTERVAL, days: DAYS, initialEquity: INITIAL_EQUITY, slippagePct: SLIPPAGE_PCT*100, feePct: FEE_PCT*100 },
    metrics,
    equity_curve,
    trades: trades.map(t => ({
      ...t,
      openedAt:  new Date(t.openedAt).toISOString(),
      closedAt:  new Date(t.closedAt).toISOString(),
    })),
  }, null, 2));
  console.log(`\nResults saved: ${outFile}`);

  return { metrics, equity_curve, trades };
}

main().catch(console.error);
