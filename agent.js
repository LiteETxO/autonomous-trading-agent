/**
 * agent.js — Autonomous trading agent
 * Model : Claude Opus 4.6 (effort: high)
 * Stack : Bybit + 4 DEXes + adaptive strategy
 */

import Anthropic from "@anthropic-ai/sdk";
import { executeTool,    BYBIT_TOOL_DEFS   } from "./bybit-agent-tools.js";
import { executeDexTool, DEX_TOOL_DEFS     } from "./dex-agent-tools.js";
import { decide, loadParams, STRATEGY_SYSTEM_PROMPT } from "./strategy.js";
import { recordTrade, shouldReEvaluate    } from "./performance-tracker.js";
import { runAdaptiveCycle                 } from "./adaptive.js";
import { notifyTaskStart, notifyTrade, notifyPass, notifyError } from "./notify.js";

const MODEL  = "claude-opus-4-6";
const EFFORT = "high";
const client = new Anthropic();

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

  const allTools = [...BYBIT_TOOL_DEFS, ...DEX_TOOL_DEFS].map(t => ({ ...t, type: "custom" }));
  const messages = [{ role: "user", content: task }];
  let iteration  = 0, finalText = "";

  try {
    while (iteration < maxIterations) {
      iteration++;
      const response = await client.messages.create({
        model:    MODEL,
        max_tokens: 4096,
        thinking:   { type: "adaptive" },
        metadata:   { effort: EFFORT },
        system:     STRATEGY_SYSTEM_PROMPT,
        tools:      allTools,
        messages,
      });

      for (const b of response.content) {
        if (b.type === "thinking") console.log("[thinking]", b.thinking.slice(0, 500));
        if (b.type === "text" && b.text.trim()) { console.log("[response]", b.text); finalText = b.text; }
      }

      const toolUses = response.content.filter(b => b.type === "tool_use");
      if (!toolUses.length || response.stop_reason === "end_turn") {
        if (/^PASS:/i.test(finalText.trim())) await notifyPass(finalText.replace(/^PASS:\s*/i, "").slice(0, 300));
        break;
      }

      messages.push({ role: "assistant", content: response.content });
      const results = [];

      for (const tu of toolUses) {
        const result = await executeTool_(tu.name, tu.input);
        console.log(`[tool] ${tu.name} →`, result.slice(0, 120));

        // Record completed trade + fire notification
        const isOrder = ["place_order","hl_place_perp","hl_place_spot","dydx_place_order","gmx_place_order","uniswap_swap"].includes(tu.name);
        if (isOrder && !result.includes("REJECTED")) {
          const inp = tu.input;
          await notifyTrade({ ...inp, testnet: process.env.BYBIT_TESTNET !== "false" });
          // recordTrade() called when position closes — add to your position monitor
        }

        results.push({ type: "tool_result", tool_use_id: tu.id, content: result });
      }

      messages.push({ role: "user", content: results });
    }
    if (iteration >= maxIterations) await notifyError("Max iterations reached.");
  } catch (err) {
    await notifyError(err.message);
    throw err;
  }
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
