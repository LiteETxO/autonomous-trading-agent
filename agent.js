/**
 * agent.js — Autonomous trading agent
 * Model : Claude Opus 4.6 (effort: high)
 * Stack : Bybit + 4 DEXes + adaptive strategy
 */

import fs       from "fs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI   from "openai";
import { executeTool,    BYBIT_TOOL_DEFS   } from "./bybit-agent-tools.js";
import { executeDexTool, DEX_TOOL_DEFS     } from "./dex-agent-tools.js";
import { executePolyTool, POLYMARKET_TOOL_DEFS } from "./polymarket-agent-tools.js";
import { decide, STRATEGY_SYSTEM_PROMPT, POLYMARKET_STRATEGY_ADDENDUM, MAX_POSITIONS, TRADE_THRESHOLD, TIER1_SYMBOLS, TIER2_LIMIT } from "./strategy.js";
import { loadParams } from "./adaptive.js";
import { recordTrade, shouldReEvaluate    } from "./performance-tracker.js";
import { runAdaptiveCycle                 } from "./adaptive.js";
import { notifyTaskStart, notifyTrade, notifyPass, notifyError } from "./notify.js";
import { reporter } from "./reporter.js";
import { registerPosition } from "./register-position.js";

// ─── Sentiment / market-context tools (no API key needed) ────────────────────

export const SENTIMENT_TOOL_DEFS = [
  {
    name: "finish_cycle",
    description: "Call this ONLY after you have completed ALL steps: collected tickers, called tier1_screen, done Tier 2 analysis, and placed all qualifying orders. Pass a brief summary. Do NOT call this early — it ends the cycle.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-paragraph summary of what was done this cycle" },
        action:  { type: "string", enum: ["TRADE", "PASS"], description: "Whether orders were placed" },
      },
      required: ["summary", "action"],
    },
  },
  {
    name: "get_market_sentiment",
    description: "Returns the Crypto Fear & Greed Index (0–100) and top trending coins on CoinGecko. Use once per cycle before scoring. Extreme fear (<25) = contrarian long signal (+10 pts). Extreme greed (>75) = caution (−10 pts). Trending coins get +5 pts.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_derivatives_data",
    description: "Returns Bybit futures open interest and long/short account ratio for a symbol. High sell ratio (sellRatio > 0.55) means shorts dominating — squeeze potential, add +10 pts. Low sell ratio (sellRatio < 0.40) means crowded longs — subtract 5 pts.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Symbol e.g. BTCUSDT" },
      },
      required: ["symbol"],
    },
  },
];

async function executeSentimentTool(name, input) {
  const BASE = `http://localhost:${process.env.PORT || 3001}`;
  try {
    if (name === "get_market_sentiment") {
      const [fgRes, trendRes] = await Promise.all([
        fetch("https://api.alternative.me/fng/?limit=1"),
        fetch("https://api.coingecko.com/api/v3/search/trending"),
      ]);
      const fg    = await fgRes.json();
      const trend = await trendRes.json();
      const fgVal = parseInt(fg.data?.[0]?.value || 50);
      const fgCls = fg.data?.[0]?.value_classification || "Neutral";
      const trendCoins = (trend.coins || []).slice(0, 7).map(c => c.item?.symbol?.toUpperCase()).filter(Boolean);
      return `Fear & Greed: ${fgVal}/100 — ${fgCls}\nTrending on CoinGecko: ${trendCoins.join(', ') || 'n/a'}`;
    }

    if (name === "get_derivatives_data") {
      const sym = (input.symbol || "").toUpperCase();
      const [oiRes, lsRes] = await Promise.all([
        fetch(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=5min&limit=1`),
        fetch(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&limit=1`),
      ]);
      const oiData = await oiRes.json();
      const lsData = await lsRes.json();
      const oi         = parseFloat(oiData.result?.list?.[0]?.openInterest || 0);
      const buyRatio   = parseFloat(lsData.result?.list?.[0]?.buyRatio  || 0.5);
      const sellRatio  = parseFloat(lsData.result?.list?.[0]?.sellRatio || 0.5);
      const bias = sellRatio > 0.55 ? "SHORT-HEAVY (squeeze potential)" :
                   buyRatio  > 0.60 ? "LONG-HEAVY (crowded longs)"      : "BALANCED";
      return `${sym} derivatives | OI: ${oi.toLocaleString()} | Long: ${(buyRatio*100).toFixed(1)}% / Short: ${(sellRatio*100).toFixed(1)}% | Bias: ${bias}`;
    }
  } catch (e) {
    return `[sentiment tool error: ${e.message}]`;
  }
  return "[unknown sentiment tool]";
}

// Load .env
try {
  fs.readFileSync(".env", "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

const PROVIDER = process.env.MOONSHOT_API_KEY ? "moonshot" : "anthropic";
const MODEL    = PROVIDER === "moonshot" ? "moonshot-v1-128k" : "claude-opus-4-6";

const client = PROVIDER === "moonshot"
  ? new OpenAI({ apiKey: process.env.MOONSHOT_API_KEY, baseURL: "https://api.moonshot.ai/v1" })
  : new Anthropic();

console.log(`[agent] provider: ${PROVIDER} | model: ${MODEL}`);

// ─── Pre-flight: adaptive cycle check ────────────────────────────────────────

async function preflightCheck() {
  const trigger = shouldReEvaluate();
  if (trigger.yes) {
    console.log(`[agent] adaptive re-eval triggered: ${trigger.reason}`);
    await runAdaptiveCycle({ symbol: "ETHUSDT" });
  }
}

// ─── Tool dispatcher ──────────────────────────────────────────────────────────

async function executeTool_(name, input) {
  if (["get_market_sentiment","get_derivatives_data"].includes(name))
    return executeSentimentTool(name, input);
  if (name === "finish_cycle") return `CYCLE_DONE: ${input.action || "PASS"} — ${(input.summary || "").slice(0, 200)}`;
  if (name.startsWith("polymarket_")) return executePolyTool(name, input);
  const isDex = ["hl_","uniswap_","dydx_","gmx_"].some(p => name.startsWith(p));
  return isDex ? executeDexTool(name, input) : executeTool(name, input);
}

const inferVenue = n =>
  n.startsWith("hl_")      ? "hl"      :
  n.startsWith("dydx_")    ? "dydx"    :
  n.startsWith("gmx_")     ? "gmx"     :
  n.startsWith("uniswap_")     ? "uniswap"     :
  n.startsWith("polymarket_")  ? "polymarket"  : "bybit";

// ─── Agent loop ───────────────────────────────────────────────────────────────

export async function runAgent(task, { maxIterations = 100 } = {}) {
  await preflightCheck();

  // Load current (possibly freshly updated) strategy params
  const params = loadParams();
  console.log(`\n[agent] params v${params.version} | threshold: ${params.tradeThreshold} | stop: ${params.stopPct}% | tp: ${params.tpPct}%`);

  await notifyTaskStart(task);
  reporter.status("running", task);
  reporter.params(params);

  // Report real Bybit balance + holdings to dashboard
  try {
    const balResult = await executeTool("get_balance", { coin: "USDT" });
    const eqMatch = balResult.match(/Equity:\s*([\d.]+)/);
    if (eqMatch) reporter.equity(parseFloat(eqMatch[1]));
    // Parse individual holdings: "    BTC: 1.001041 (≈$72350.29)"
    const holdings = [...balResult.matchAll(/^\s{4}(\w+):\s*([\d.]+)\s*\(≈\$([\d.]+)\)/gm)]
      .map(m => ({ coin: m[1], qty: parseFloat(m[2]), usdValue: parseFloat(m[3]) }));
    if (holdings.length) reporter.holdings(holdings);
  } catch {}

  const walletReady = process.env.WALLET_PRIVATE_KEY &&
    !process.env.WALLET_PRIVATE_KEY.startsWith("0x...") &&
    process.env.WALLET_PRIVATE_KEY.length >= 32;
  const activeTools = [...BYBIT_TOOL_DEFS, ...(walletReady ? DEX_TOOL_DEFS : []), ...SENTIMENT_TOOL_DEFS, ...POLYMARKET_TOOL_DEFS];
  if (!walletReady) console.log("[agent] DEX tools disabled — WALLET_PRIVATE_KEY not configured");

  const anthropicTools = activeTools.map(t => ({ ...t, type: "custom" }));
  const openaiTools    = activeTools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const messages = PROVIDER === "moonshot"
    ? [{ role: "system", content: STRATEGY_SYSTEM_PROMPT }, { role: "user", content: task }]
    : [{ role: "user", content: task }];

  // Load current open position count from registry
  let currentOpenCount = 0;
  try {
    const reg = JSON.parse(fs.readFileSync("./data/open-positions.json", "utf8"));
    currentOpenCount = (reg.positions || []).filter(p => p.status === "open").length;
  } catch {}

  let iteration = 0, finalText = "";
  let positionsOpenedThisCycle = 0;
  const symbolsOpenedThisCycle = new Set();

  try {
    while (iteration < maxIterations) {
      iteration++;

      let toolUses, msgContent;

      if (PROVIDER === "moonshot") {
        // Keep tool_choice="required" until model calls finish_cycle
        const toolChoiceMode = "required";
        const response = await client.chat.completions.create({
          model: MODEL, max_tokens: 4096,
          tools: openaiTools, tool_choice: toolChoiceMode, messages,
        });
        const msg = response.choices[0].message;
        if (msg.content) { console.log("[response]", msg.content); finalText = msg.content; reporter.feed(msg.content, "sys"); }
        toolUses = (msg.tool_calls || []).map(tc => ({
          id: tc.id, name: tc.function.name,
          input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
        }));
        msgContent = msg;
        // Break when model calls finish_cycle or truly has no tools
        const finishCall = toolUses.find(t => t.name === "finish_cycle");
        if (finishCall || (!toolUses.length && response.choices[0].finish_reason === "stop")) {
          const summary = finishCall ? finishCall.input.summary || "" : finalText;
          if (/PASS/i.test(finishCall?.input?.action || "")) await notifyPass(summary.slice(0, 300));
          break;
        }
        messages.push(msg);
      } else {
        const apiTimeout = new Promise((_,rej)=>setTimeout(()=>rej(new Error('Claude API timeout after 5 min')),300000));
        const response = await Promise.race([
          client.messages.create({
            model: MODEL, max_tokens: 4096,
            system: STRATEGY_SYSTEM_PROMPT + POLYMARKET_STRATEGY_ADDENDUM, tools: anthropicTools, messages,
          }),
          apiTimeout
        ]);
        for (const b of response.content) {
          if (b.type === "thinking") console.log("[thinking]", b.thinking.slice(0, 500));
          if (b.type === "text" && b.text.trim()) { console.log("[response]", b.text); finalText = b.text; }
        }
        toolUses = response.content.filter(b => b.type === "tool_use")
          .map(b => ({ id: b.id, name: b.name, input: b.input }));
        if (!toolUses.length || response.stop_reason === "end_turn") {
          if (/^PASS:/i.test(finalText.trim())) await notifyPass(finalText.replace(/^PASS:\s*/i, "").slice(0, 300));
          break;
        }
        messages.push({ role: "assistant", content: response.content });
      }

      const results = [];
      for (const tu of toolUses) {
        const result = await executeTool_(tu.name, tu.input);
        console.log(`[tool] ${tu.name} →`, result.slice(0, 120));

        reporter.feed(`[${tu.name}] ${result.slice(0, 120)}`, "tool");

        const isOrder   = ["place_order","hl_place_perp","hl_place_spot","dydx_place_order","gmx_place_order","uniswap_swap"].includes(tu.name);
        const isBuy     = ["buy","Buy","BUY"].includes(tu.input?.side);
        const isClose   = ["sell","Sell","SELL"].includes(tu.input?.side);

        // Hard block: max simultaneous positions (imported from strategy.js), no duplicate symbols
        const totalOpen = currentOpenCount + positionsOpenedThisCycle;
        const sym = tu.input?.symbol || tu.input?.coin || "";
        if (isOrder && isBuy && (totalOpen >= MAX_POSITIONS || symbolsOpenedThisCycle.has(sym))) {
          const reason = totalOpen >= MAX_POSITIONS
            ? `REJECTED: max ${MAX_POSITIONS} simultaneous positions reached (${totalOpen} open).`
            : `REJECTED: already opened ${sym} this cycle.`;
          results.push(PROVIDER === "moonshot"
            ? { role: "tool", tool_call_id: tu.id, content: reason }
            : { type: "tool_result", tool_use_id: tu.id, content: reason }
          );
          continue;
        }

        if (isOrder && !result.includes("REJECTED") && !result.toLowerCase().includes("error") && !result.toLowerCase().includes("failed")) {
          const inp   = tu.input;
          const venue = inferVenue(tu.name);

          // Re-fetch real balance after any order
          try {
            const balResult = await executeTool("get_balance", { coin: "USDT" });
            const eqMatch = balResult.match(/Equity:\s*([\d.]+)/);
            if (eqMatch) reporter.equity(parseFloat(eqMatch[1]));
            const holdings = [...balResult.matchAll(/^\s{4}(\w+):\s*([\d.]+)\s*\(≈\$([\d.]+)\)/gm)]
              .map(m => ({ coin: m[1], qty: parseFloat(m[2]), usdValue: parseFloat(m[3]) }));
            if (holdings.length) reporter.holdings(holdings);
          } catch {}

          if (isBuy) {
            positionsOpenedThisCycle++;
            symbolsOpenedThisCycle.add(sym);
            // ── Opening a new position ──────────────────────────────────────
            // For market orders, price isn't in input — fetch live ticker price
            let entryPrice = parseFloat(inp.limitPx || inp.price || 0);
            if (!entryPrice) {
              try {
                const tickResult = await executeTool("get_ticker", { symbol: inp.symbol || inp.coin });
                const m = tickResult.match(/Last:\s*\$?([\d.]+)/);
                if (m) entryPrice = parseFloat(m[1]);
              } catch {}
            }

            const sizeUsd   = entryPrice > 0 ? +((inp.qty || 0) * entryPrice).toFixed(2) : (inp.qty || 50);
            const stopPct   = params.stopPct / 100;
            const tpPct     = params.tpPct   / 100;
            const stopPrice = +(entryPrice * (1 - stopPct)).toFixed(2);
            const tpPrice   = +(entryPrice * (1 + tpPct)).toFixed(2);
            const posId     = `pos-${Date.now()}`;

            // ── Stop precision guard ───────────────────────────────────────
            // If stop rounds to same as entry (e.g. DOGE $0.09), position tracking
            // will be broken. Log the warning but continue — the order already went through.
            if (stopPrice === +entryPrice.toFixed(2)) {
              reporter.feed(`⚠ STOP PRECISION: ${inp.symbol || inp.coin} entry $${entryPrice} stop $${stopPrice} — stop equals entry due to price precision. Monitor this manually.`, "error");
            }

            await notifyTrade({ ...inp, testnet: process.env.BYBIT_TESTNET !== "false" });
            reporter.feed(`BUY ${inp.symbol} $${sizeUsd} @ $${entryPrice} | stop $${stopPrice} | tp $${tpPrice}`, "buy");

            try {
              registerPosition({
                id: posId, venue,
                symbol:      inp.symbol || inp.coin,
                side:        "long",
                entryPrice,  sizeUsd, stopPrice, tpPrice,
                venueOrderId: result.match(/orderId:\s*(\S+)/)?.[1],
              });
            } catch {}

            // ── Entry log — structured record for backtesting / analysis ──
            try {
              let log = [];
              try { log = JSON.parse(fs.readFileSync(ENTRY_LOG_PATH, "utf8")); } catch {}

              // Extract funding bucket from agent's latest output
              const rationale = finalText.slice(-1200);
              const fundingBucket =
                /bucket=STRONG|ELIGIBLE-STRONG/i.test(rationale) ? "STRONG" :
                /bucket=WEAK|ELIGIBLE-WEAK/i.test(rationale)     ? "WEAK"   :
                /bucket=ELIGIBLE/i.test(rationale)                ? "ELIGIBLE" : "unknown";
              // Extract funding rate value
              const fundingMatch = rationale.match(/funding=([-\d.]+)%\/8h/i);
              const fundingRateLogged = fundingMatch ? parseFloat(fundingMatch[1]) : null;

              log.push({
                ts:            new Date().toISOString(),
                id:            posId,
                symbol:        inp.symbol || inp.coin,
                side:          "long",
                entryPrice,
                sizeUsd,
                stopPrice,
                tpPrice,
                stopPct:       +(stopPct * 100).toFixed(1),
                tpPct:         +(tpPct   * 100).toFixed(1),
                fundingBucket,
                fundingRate:   fundingRateLogged,
                outcome:       "open",   // updated to "won"/"lost" by position-monitor
                exitPrice:     null,
                pnl:           null,
                paramsVersion: params.version,
                agentRationale: rationale,
              });
              fs.writeFileSync(ENTRY_LOG_PATH, JSON.stringify(log, null, 2));
            } catch {}

            reporter.position({
              id: posId, venue,
              symbol:    inp.symbol || inp.coin,
              side:      "long",
              sizeUsd,   entryPrice, stopPrice, tpPrice,
              status:    "open",
              openedAt:  new Date().toISOString(),
            });

          } else if (isClose) {
            // ── Closing an existing position (agent-initiated exit) ─────────
            reporter.feed(`SELL/CLOSE ${inp.symbol} qty=${inp.qty}`, "sell");
            // Position monitor will detect the fill and mark it closed on next poll
          }
        }

        if (PROVIDER === "moonshot") {
          results.push({ role: "tool", tool_call_id: tu.id, content: result });
        } else {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
        }
      }

      if (PROVIDER === "moonshot") {
        messages.push(...results);
      } else {
        messages.push({ role: "user", content: results });
      }
    }
    if (iteration >= maxIterations) await notifyError("Max iterations reached.");
  } catch (err) {
    await notifyError(err.message);
    reporter.feed(err.message, "error");
    throw err;
  }

  // End-of-cycle: post feed summary + refresh equity
  const tradedThis = positionsOpenedThisCycle > 0;
  reporter.feed(
    tradedThis
      ? `Cycle complete — ${positionsOpenedThisCycle} new position(s) opened`
      : "Cycle complete — no signal found, idle",
    tradedThis ? "sys" : "pass"
  );

  try {
    const balResult = await executeTool("get_balance", { coin: "USDT" });
    const eqMatch = balResult.match(/Equity:\s*([\d.]+)/);
    if (eqMatch) reporter.equity(parseFloat(eqMatch[1]));
    const holdings = [...balResult.matchAll(/^\s{4}(\w+):\s*([\d.]+)\s*\(≈\$([\d.]+)\)/gm)]
      .map(m => ({ coin: m[1], qty: parseFloat(m[2]), usdValue: parseFloat(m[3]) }));
    if (holdings.length) reporter.holdings(holdings);
  } catch {}

  reporter.status("idle", "");
}

const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MINUTES || "5") * 60 * 1000;
const ENTRY_LOG_PATH   = "./data/entry-log.json";

// ─── Build entry-log feedback summary ────────────────────────────────────────
// Read closed entries and compute win-rate per funding bucket.
// Injected into the task prompt each cycle so the agent knows what's working.

function buildEntryLogSummary() {
  try {
    const entries = JSON.parse(fs.readFileSync(ENTRY_LOG_PATH, "utf8"));
    if (!entries.length) return null;

    const total  = entries.length;
    const closed = entries.filter(e => e.outcome === "won" || e.outcome === "lost");
    const open   = total - closed.length;

    // Bucket stats
    const buckets = { "STRONG": [], "ELIGIBLE": [], "WEAK": [], "unknown": [] };
    for (const e of closed) {
      const b = e.fundingBucket || "unknown";
      const key = b.includes("STRONG") ? "STRONG" : b.includes("WEAK") ? "WEAK" : b === "ELIGIBLE" ? "ELIGIBLE" : "unknown";
      buckets[key].push(e.outcome === "won");
    }

    const fmtBucket = (label, results) => {
      if (!results.length) return null;
      const wins = results.filter(Boolean).length;
      return `  ${label}: ${wins}/${results.length} (${Math.round(wins/results.length*100)}% win rate)`;
    };

    const lines = [
      `ENTRY LOG: ${total} total entries | ${open} open | ${closed.length} closed`,
    ];
    const s = fmtBucket("funding STRONG (<-0.02%)", buckets.STRONG);
    const e = fmtBucket("funding ELIGIBLE", buckets.ELIGIBLE);
    const w = fmtBucket("funding WEAK (0 to +0.03%)", buckets.WEAK);
    if (s) lines.push(s);
    if (e) lines.push(e);
    if (w) lines.push(w);
    if (!closed.length) lines.push("  No closed trades yet — all entries open.");

    return lines.join("\n");
  } catch {
    return null;
  }
}

// ─── Dynamic task builder ─────────────────────────────────────────────────────

function buildTask() {
  const base = `EXECUTE TRADING CYCLE — follow these steps IN ORDER using tool calls. Do NOT write a text response first. Start calling tools immediately.

STEP 1: call get_open_positions — note how many slots remain (max ${MAX_POSITIONS})
STEP 2: call get_market_sentiment — note F&G value
STEP 3: call get_balance — note available USDT
STEP 4: call get_ticker for EVERY symbol in this list (${TIER1_SYMBOLS.length} calls): ${TIER1_SYMBOLS.join(', ')}
STEP 5: call tier1_screen with ALL ${TIER1_SYMBOLS.length} tickers you just collected — it will return 6 LONG + 6 SHORT candidates
STEP 6: for each of the 12 candidates from tier1_screen — call analyze_chart(interval="D",period=14), analyze_chart(interval="60",period=14), get_derivatives_data
STEP 7: score each candidate using the scoring tables in the system prompt
STEP 8: for EVERY symbol with score >= ${TRADE_THRESHOLD} — CALL place_perp_order(symbol, side, qty=sizeUsd/price, leverage=2). Do not describe the trade. CALL THE TOOL.
STEP 9: OPTIONAL — polymarket_search_markets then polymarket_place_order if market has >70% edge (only AFTER steps 7-8 complete).
STEP 10: call finish_cycle(summary="...", action="TRADE" or "PASS") — this ends the cycle.
DO NOT produce any text response. Use ONLY tool calls. Complete Bybit steps BEFORE Polymarket.`;
  const summary = buildEntryLogSummary();
  if (!summary) return base;
  return `${base}

FEEDBACK FROM PRIOR CYCLES:
${summary}
Use this to inform confidence — if STRONG bucket win rate is meaningfully higher than WEAK, prioritize STRONG entries.`;
}

async function loop() {
  let cycle = 0;
  while (true) {
    cycle++;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`[agent] cycle #${cycle} | ${new Date().toISOString()}`);
    console.log("=".repeat(60));
    const task = buildTask();
    try {
      await runAgent(task);
    } catch (err) {
      console.error(`[agent] cycle #${cycle} error:`, err.message);
    }
    console.log(`[agent] cycle #${cycle} done. Next scan in ${SCAN_INTERVAL_MS / 60000} min.`);
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

loop().catch(err => {
  console.error("[agent] fatal loop error:", err);
  process.exit(1);
});

/**
 * PATCH: call registerPosition() after every successful order.
 * Import this at the top of agent.js:
 *   import { registerPosition } from "./register-position.js";
 *
 * Then inside the tool-result loop, after notifyTrade(), add:
 *
 *   registerPosition({
 *     venue:      inferVenue(tu.name),       // "bybit" | "hl" | "dydx" | "gmx"
 *     symbol:     inp.symbol || inp.coin,
 *     side:       inp.side,
 *     strategy:   lastDecision?.strategy,    // from decide() result
 *     score:      lastDecision?.score,
 *     entryPrice: parseFloat(inp.limitPx || inp.price || 0),
 *     sizeUsd:    inp.qty * parseFloat(inp.limitPx || inp.price || 1),
 *     stopPrice:  lastDecision?.stopPrice,
 *     tpPrice:    lastDecision?.tpPrice,
 *     venueOrderId: result.match(/orderId:\s*(\S+)/)?.[1],
 *   });
 *
 * inferVenue helper:
 *   const inferVenue = n =>
 *     n.startsWith("hl_")       ? "hl"    :
 *     n.startsWith("dydx_")     ? "dydx"  :
 *     n.startsWith("gmx_")      ? "gmx"   :
 *     n.startsWith("uniswap_")  ? "uniswap" : "bybit";
 */
