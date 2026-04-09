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
import { decide, STRATEGY_SYSTEM_PROMPT } from "./strategy.js";
import { loadParams } from "./adaptive.js";
import { recordTrade, shouldReEvaluate    } from "./performance-tracker.js";
import { runAdaptiveCycle                 } from "./adaptive.js";
import { notifyTaskStart, notifyTrade, notifyPass, notifyError } from "./notify.js";
import { reporter } from "./reporter.js";

// Load .env
try {
  fs.readFileSync(".env", "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
} catch {}

const PROVIDER = process.env.MOONSHOT_API_KEY ? "moonshot" : "anthropic";
const MODEL    = PROVIDER === "moonshot" ? "moonshot-v1-32k" : "claude-opus-4-6";
const EFFORT   = "high";

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
  const isDex = ["hl_","uniswap_","dydx_","gmx_"].some(p => name.startsWith(p));
  return isDex ? executeDexTool(name, input) : executeTool(name, input);
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

export async function runAgent(task, { maxIterations = 12 } = {}) {
  await preflightCheck();

  // Load current (possibly freshly updated) strategy params
  const params = loadParams();
  console.log(`\n[agent] params v${params.version} | threshold: ${params.tradeThreshold} | stop: ${params.stopPct}% | tp: ${params.tpPct}%`);

  await notifyTaskStart(task);
  reporter.status("running", task);
  reporter.params(params);

  // Report real Bybit balance to dashboard
  try {
    const balResult = await executeTool("get_balance", { coin: "USDT" });
    const match = balResult.match(/Equity:\s*(\d+\.?\d*)/);
    if (match) reporter.equity(parseFloat(match[1]));
  } catch {}

  const walletReady = process.env.WALLET_PRIVATE_KEY &&
    !process.env.WALLET_PRIVATE_KEY.startsWith("0x...") &&
    process.env.WALLET_PRIVATE_KEY.length >= 32;
  const activeTools = walletReady ? [...BYBIT_TOOL_DEFS, ...DEX_TOOL_DEFS] : BYBIT_TOOL_DEFS;
  if (!walletReady) console.log("[agent] DEX tools disabled — WALLET_PRIVATE_KEY not configured");

  const anthropicTools = activeTools.map(t => ({ ...t, type: "custom" }));
  const openaiTools    = activeTools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  const messages = PROVIDER === "moonshot"
    ? [{ role: "system", content: STRATEGY_SYSTEM_PROMPT }, { role: "user", content: task }]
    : [{ role: "user", content: task }];

  let iteration = 0, finalText = "";

  try {
    while (iteration < maxIterations) {
      iteration++;

      let toolUses, msgContent;

      if (PROVIDER === "moonshot") {
        const response = await client.chat.completions.create({
          model: MODEL, max_tokens: 4096,
          tools: openaiTools, tool_choice: "auto", messages,
        });
        const msg = response.choices[0].message;
        if (msg.content) { console.log("[response]", msg.content); finalText = msg.content; reporter.feed(msg.content, "sys"); }
        toolUses = (msg.tool_calls || []).map(tc => ({
          id: tc.id, name: tc.function.name,
          input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
        }));
        msgContent = msg;
        if (!toolUses.length || response.choices[0].finish_reason === "stop") {
          if (/^PASS:/i.test(finalText.trim())) await notifyPass(finalText.replace(/^PASS:\s*/i, "").slice(0, 300));
          break;
        }
        messages.push(msg);
      } else {
        const response = await client.messages.create({
          model: MODEL, max_tokens: 4096,
          thinking: { type: "adaptive" }, metadata: { effort: EFFORT },
          system: STRATEGY_SYSTEM_PROMPT, tools: anthropicTools, messages,
        });
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

        const isOrder = ["place_order","hl_place_perp","hl_place_spot","dydx_place_order","gmx_place_order","uniswap_swap"].includes(tu.name);
        if (isOrder && !result.includes("REJECTED")) {
          await notifyTrade({ ...tu.input, testnet: process.env.BYBIT_TESTNET !== "false" });
          reporter.feed(`Trade: ${tu.input.side?.toUpperCase()} ${tu.input.symbol} $${tu.input.qty}`, "buy");
          reporter.equity(parseFloat(result.match(/\$(\d+\.?\d*)/)?.[1] || 0));
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
  reporter.status("idle", "");
}

const task = process.argv[2] ?? "Scan all venues. Check funding arb opportunities first, then score directional signals. Use current strategy params. Report decision.";
runAgent(task).catch(console.error);

/**
 * PATCH: call registerPosition() after every successful order.
 * Import this at the top of agent.js:
 *   import { registerPosition } from "./position-monitor.js";
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
