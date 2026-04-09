/**
 * strategy.js
 * Trading brain for the autonomous agent
 *
 * Architecture:
 *   Layer 1 — Funding rate arbitrage   (always running, passive income)
 *   Layer 2 — News-driven momentum     (fires on high-conviction events)
 *   Layer 3 — Composite signal filter  (blocks low-quality trades)
 *
 * Risk:
 *   Per-trade stop  : -3%  |  take-profit: +6%   (2:1 R/R minimum)
 *   Daily circuit   : -8%  portfolio drawdown → pause 24h
 *   Peak drawdown   : -15% from equity peak → full stop, notify operator
 *   Correlation cap : no same-direction exposure across 2+ venues simultaneously
 */

// ─── State (persisted to state.json in production) ────────────────────────────

let state = {
  equityPeak:    null,    // highest recorded total equity
  dailyStartEq:  null,    // equity at start of current trading day
  dailyResetAt:  null,    // ISO timestamp of last daily reset
  paused:        false,
  pauseReason:   null,
  pauseUntil:    null,    // ISO timestamp
  tradeCount:    0,
  wins:          0,
  losses:        0,
};

export function loadState(s) { Object.assign(state, s); }
export function getState()   { return { ...state }; }

// ─── 1. SIGNAL SCORING ENGINE ─────────────────────────────────────────────────
//
// Returns a score 0–100. Only trade when score ≥ TRADE_THRESHOLD.
// Each signal contributes independently — the more that agree, the higher the score.
//
// TRADE_THRESHOLD = 65   (standard trade)
// STRONG_THRESHOLD = 80  (news momentum trade — requires higher conviction)

const TRADE_THRESHOLD  = 65;
const STRONG_THRESHOLD = 80;

/**
 * Score a potential trade given market context.
 *
 * @param {object} ctx
 *   ctx.rsi           number   14-period RSI
 *   ctx.priceVsSma    number   % price is above/below SMA (positive = above)
 *   ctx.fundingRate   number   current 8h funding rate (positive = longs pay)
 *   ctx.volumeSpike   boolean  volume > 1.5× 14-day average
 *   ctx.newsSentiment number   -1 (bearish) to +1 (bullish), 0 = neutral
 *   ctx.side          string   "long" | "short"
 *   ctx.venueFee      number   estimated fee % for this venue
 *
 * @returns {object} { score, signals, recommendation }
 */
export function scoreSignals(ctx) {
  const { rsi, priceVsSma, fundingRate, volumeSpike, newsSentiment, side, venueFee = 0.05 } = ctx;
  const isLong = side === "long";
  const signals = [];
  let score = 0;

  // ── RSI signal (25 pts) ───────────────────────────────────────────────────
  // Long: prefer RSI 40–60 (momentum) or < 35 (oversold bounce)
  // Short: prefer RSI > 60 or > 65 (overbought)
  if (isLong) {
    if (rsi >= 40 && rsi <= 60)       { score += 20; signals.push(`RSI ${rsi.toFixed(0)} in neutral-bullish zone (+20)`); }
    else if (rsi < 35)                 { score += 25; signals.push(`RSI ${rsi.toFixed(0)} oversold — bounce setup (+25)`); }
    else if (rsi > 75)                 { score -= 30; signals.push(`RSI ${rsi.toFixed(0)} overbought — BLOCK long (-30)`); }
    else                               { score +=  5; signals.push(`RSI ${rsi.toFixed(0)} neutral (+5)`); }
  } else {
    if (rsi > 65 && rsi <= 78)         { score += 20; signals.push(`RSI ${rsi.toFixed(0)} overbought — short setup (+20)`); }
    else if (rsi > 78)                 { score += 25; signals.push(`RSI ${rsi.toFixed(0)} extreme overbought (+25)`); }
    else if (rsi < 30)                 { score -= 30; signals.push(`RSI ${rsi.toFixed(0)} oversold — BLOCK short (-30)`); }
    else                               { score +=  5; signals.push(`RSI ${rsi.toFixed(0)} neutral (+5)`); }
  }

  // ── SMA trend (20 pts) ────────────────────────────────────────────────────
  if (isLong && priceVsSma > 1)        { score += 20; signals.push(`Price ${priceVsSma.toFixed(1)}% above SMA — uptrend (+20)`); }
  else if (isLong && priceVsSma < -2)  { score -=  5; signals.push(`Price ${priceVsSma.toFixed(1)}% below SMA — weak (-5)`); }
  else if (!isLong && priceVsSma < -1) { score += 20; signals.push(`Price ${priceVsSma.toFixed(1)}% below SMA — downtrend (+20)`); }
  else if (!isLong && priceVsSma > 2)  { score -=  5; signals.push(`Price ${priceVsSma.toFixed(1)}% above SMA — weak short (-5)`); }
  else                                  { score += 10; signals.push(`Price near SMA — ranging (+10)`); }

  // ── Funding rate (20 pts) ─────────────────────────────────────────────────
  // Positive funding = longs pay shorts. High positive = crowded long = fade signal.
  // Negative funding = shorts pay longs = good for longs (market is bearish, mean-revert).
  if (isLong) {
    if (fundingRate < -0.01)           { score += 20; signals.push(`Funding ${fundingRate.toFixed(4)}% negative — longs get paid (+20)`); }
    else if (fundingRate > 0.04)       { score -= 20; signals.push(`Funding ${fundingRate.toFixed(4)}% very high — crowded long (-20)`); }
    else if (fundingRate > 0.02)       { score -=  5; signals.push(`Funding ${fundingRate.toFixed(4)}% elevated (-5)`); }
    else                               { score += 10; signals.push(`Funding ${fundingRate.toFixed(4)}% neutral (+10)`); }
  } else {
    if (fundingRate > 0.04)            { score += 20; signals.push(`Funding ${fundingRate.toFixed(4)}% very high — short gets paid (+20)`); }
    else if (fundingRate < -0.01)      { score -= 15; signals.push(`Funding ${fundingRate.toFixed(4)}% negative — costly short (-15)`); }
    else                               { score += 10; signals.push(`Funding ${fundingRate.toFixed(4)}% neutral (+10)`); }
  }

  // ── Volume (15 pts) ───────────────────────────────────────────────────────
  if (volumeSpike)                     { score += 15; signals.push(`Volume spike detected — conviction (+15)`); }
  else                                  { score +=  5; signals.push(`Volume normal (+5)`); }

  // ── News sentiment (20 pts) ───────────────────────────────────────────────
  const sentimentScore = Math.round(newsSentiment * 20);
  if ((isLong && newsSentiment > 0.3) || (!isLong && newsSentiment < -0.3)) {
    score += Math.abs(sentimentScore);
    signals.push(`News sentiment ${newsSentiment > 0 ? "bullish" : "bearish"} (+${Math.abs(sentimentScore)})`);
  } else if ((isLong && newsSentiment < -0.3) || (!isLong && newsSentiment > 0.3)) {
    score += sentimentScore; // negative
    signals.push(`News sentiment against trade direction (${sentimentScore})`);
  } else {
    signals.push(`News sentiment neutral (0)`);
  }

  // ── Fee drag check ────────────────────────────────────────────────────────
  if (venueFee > 0.1)                  { score -= 10; signals.push(`High venue fee ${venueFee}% (-10)`); }

  // Clamp
  score = Math.max(0, Math.min(100, Math.round(score)));

  const recommendation =
    score >= STRONG_THRESHOLD ? "STRONG_TRADE" :
    score >= TRADE_THRESHOLD  ? "TRADE"        : "SKIP";

  return { score, signals, recommendation, threshold: TRADE_THRESHOLD };
}

// ─── 2. KELLY POSITION SIZER ──────────────────────────────────────────────────
//
// Half-Kelly used for safety. Never exceeds MAX_ORDER_USD.
// Kelly formula: f = (bp - q) / b
//   b = odds (R/R ratio), p = win probability, q = 1 - p

const MAX_ORDER_USD    = 100;
const WIN_RR           = 2.0;   // target 2:1 reward/risk
const BASE_STOP_PCT    = 0.03;  // 3% stop loss
const BASE_TP_PCT      = 0.06;  // 6% take profit

/**
 * Calculate position size given signal score and account equity.
 *
 * @param {number} score       0–100 signal score
 * @param {number} equity      available USDT
 * @returns {object} { sizeUsd, stopPct, tpPct, kellyFraction, rationale }
 */
export function calcPositionSize(score, equity) {
  // Map score to estimated win probability (65 score ≈ 55% win rate, 90 ≈ 70%)
  const winProb = 0.40 + (score / 100) * 0.35; // 0.40 – 0.75 range
  const lossProb = 1 - winProb;
  const b = WIN_RR;

  // Full Kelly
  const kelly = (b * winProb - lossProb) / b;

  // Half-Kelly for risk management
  const halfKelly = kelly / 2;

  // Size = half-Kelly fraction of equity, capped at MAX_ORDER_USD
  const raw = halfKelly * equity;
  const sizeUsd = Math.min(MAX_ORDER_USD, Math.max(10, Math.round(raw * 100) / 100));

  // Tighten stops on weaker signals
  const stopPct = score >= 80 ? 0.025 : BASE_STOP_PCT;
  const tpPct   = score >= 80 ? 0.07  : BASE_TP_PCT;

  return {
    sizeUsd,
    stopPct,
    tpPct,
    stopPrice: null,  // caller multiplies by entry price
    tpPrice:   null,
    kellyFraction: +(halfKelly * 100).toFixed(1),
    rationale: `Score ${score} → win prob ${(winProb*100).toFixed(0)}% → Kelly ${(kelly*100).toFixed(1)}% → half-Kelly ${(halfKelly*100).toFixed(1)}% → size $${sizeUsd}`,
  };
}

// ─── 3. FUNDING RATE ARB SCANNER ─────────────────────────────────────────────
//
// Detects when funding rate discrepancy between venues is large enough
// to arb profitably after fees. Returns a trade plan or null.
//
// Strategy: if HL funding > 0.03%/8h AND spot premium < 0.05%:
//   → long spot on Uniswap/Bybit + short perp on HL
//   → collect funding 3× daily, delta-neutral

const ARB_FUNDING_THRESHOLD = 0.03;  // % per 8h
const ARB_FEE_TOTAL         = 0.15;  // % round-trip (spot + perp)

/**
 * @param {object} rates  { hl, dydx, gmx } — 8h funding rates
 * @param {number} spotPremium  % diff between perp price and spot price
 * @returns {object|null} arb plan or null
 */
export function scanFundingArb(rates, spotPremium = 0) {
  const opps = [];

  for (const [venue, rate] of Object.entries(rates)) {
    if (Math.abs(rate) < ARB_FUNDING_THRESHOLD) continue;

    // Daily yield: rate × 3 (paid 3× per day) minus round-trip fees
    const dailyYield = Math.abs(rate) * 3 - ARB_FEE_TOTAL;
    if (dailyYield <= 0) continue;

    const direction = rate > 0 ? "short_perp_long_spot" : "long_perp_short_spot";
    const annualizedPct = dailyYield * 365;

    opps.push({
      venue,
      fundingRate: rate,
      direction,
      dailyYield: +dailyYield.toFixed(4),
      annualizedPct: +annualizedPct.toFixed(1),
      spotPremiumOk: Math.abs(spotPremium) < 0.05,
      executable: Math.abs(spotPremium) < 0.05,
      rationale: `${venue} funding ${rate.toFixed(4)}%/8h → ${(dailyYield*100).toFixed(3)}%/day → ${annualizedPct.toFixed(0)}% APR`,
    });
  }

  opps.sort((a, b) => b.dailyYield - a.dailyYield);
  return opps.length > 0 ? opps : null;
}

// ─── 4. RISK MANAGER ─────────────────────────────────────────────────────────

const DAILY_DRAWDOWN_LIMIT = 0.08;   // -8%  → pause 24h
const PEAK_DRAWDOWN_LIMIT  = 0.15;   // -15% → full stop, alert operator

/**
 * Run all risk checks. Call before every trade.
 * @param {number} currentEquity
 * @returns {object} { allowed, reason }
 */
export function riskCheck(currentEquity) {
  const now = new Date();

  // ── Agent paused check ────────────────────────────────────────────────────
  if (state.paused) {
    if (state.pauseUntil && new Date(state.pauseUntil) < now) {
      state.paused = false;
      state.pauseReason = null;
      state.pauseUntil = null;
      state.dailyStartEq = currentEquity; // reset daily baseline after pause
    } else {
      return { allowed: false, reason: `Agent paused: ${state.pauseReason}. Resumes: ${state.pauseUntil || "manual"}` };
    }
  }

  // ── Init peak equity ──────────────────────────────────────────────────────
  if (!state.equityPeak || currentEquity > state.equityPeak) {
    state.equityPeak = currentEquity;
  }

  // ── Init daily baseline ───────────────────────────────────────────────────
  const todayStr = now.toISOString().slice(0,10);
  if (!state.dailyResetAt || state.dailyResetAt !== todayStr) {
    state.dailyStartEq = currentEquity;
    state.dailyResetAt = todayStr;
  }

  // ── Peak drawdown check ───────────────────────────────────────────────────
  const peakDD = (state.equityPeak - currentEquity) / state.equityPeak;
  if (peakDD >= PEAK_DRAWDOWN_LIMIT) {
    state.paused = true;
    state.pauseReason = `Peak drawdown ${(peakDD*100).toFixed(1)}% — manual restart required`;
    state.pauseUntil = null;
    return { allowed: false, reason: state.pauseReason };
  }

  // ── Daily drawdown check ──────────────────────────────────────────────────
  const dailyDD = (state.dailyStartEq - currentEquity) / state.dailyStartEq;
  if (dailyDD >= DAILY_DRAWDOWN_LIMIT) {
    const resumeAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    state.paused = true;
    state.pauseReason = `Daily drawdown ${(dailyDD*100).toFixed(1)}% — cooling off`;
    state.pauseUntil = resumeAt;
    return { allowed: false, reason: state.pauseReason };
  }

  return {
    allowed: true,
    peakDrawdownPct:  +(peakDD  * 100).toFixed(2),
    dailyDrawdownPct: +(dailyDD * 100).toFixed(2),
    marginToDaily:    +((DAILY_DRAWDOWN_LIMIT  - dailyDD) * state.dailyStartEq).toFixed(2),
    marginToPeak:     +((PEAK_DRAWDOWN_LIMIT   - peakDD)  * state.equityPeak).toFixed(2),
  };
}

/**
 * Record a trade outcome.
 */
export function recordOutcome(won) {
  state.tradeCount++;
  if (won) state.wins++; else state.losses++;
}

export function getWinRate() {
  if (!state.tradeCount) return null;
  return +(state.wins / state.tradeCount * 100).toFixed(1);
}

// ─── 5. FULL DECISION PIPELINE ────────────────────────────────────────────────
//
// The agent calls this to get a complete trade decision.
// Returns a structured action plan the agent can execute directly.

/**
 * @param {object} marketData
 *   { symbol, side, rsi, priceVsSma, fundingRates, volumeSpike,
 *     newsSentiment, currentPrice, availableEquity, venue, venueFee }
 * @returns {object} decision
 */
export function decide(marketData) {
  const {
    symbol, side, rsi, priceVsSma, fundingRates = {},
    volumeSpike = false, newsSentiment = 0,
    currentPrice, availableEquity, venue = "hl", venueFee = 0.05,
  } = marketData;

  // 1. Risk gate
  const risk = riskCheck(availableEquity);
  if (!risk.allowed) {
    return { action: "BLOCKED", reason: risk.reason };
  }

  // 2. Funding arb scan (always check first — lower risk)
  const fundingArb = scanFundingArb(fundingRates);
  if (fundingArb) {
    const best = fundingArb[0];
    if (best.executable) {
      const size = calcPositionSize(85, availableEquity); // treat arb as high-confidence
      return {
        action:    "FUNDING_ARB",
        venue:     best.venue,
        direction: best.direction,
        sizeUsd:   size.sizeUsd,
        dailyYield: best.dailyYield,
        annualizedPct: best.annualizedPct,
        rationale: best.rationale,
        riskStatus: risk,
      };
    }
  }

  // 3. Score directional trade
  const { score, signals, recommendation } = scoreSignals({
    rsi, priceVsSma,
    fundingRate: fundingRates[venue] || 0,
    volumeSpike, newsSentiment, side, venueFee,
  });

  if (recommendation === "SKIP") {
    return {
      action: "SKIP",
      score,
      reason: `Score ${score} below threshold ${TRADE_THRESHOLD}`,
      signals,
      riskStatus: risk,
    };
  }

  // 4. Size position
  const sizing = calcPositionSize(score, availableEquity);
  const stopPrice = side === "long"
    ? +(currentPrice * (1 - sizing.stopPct)).toFixed(2)
    : +(currentPrice * (1 + sizing.stopPct)).toFixed(2);
  const tpPrice = side === "long"
    ? +(currentPrice * (1 + sizing.tpPct)).toFixed(2)
    : +(currentPrice * (1 - sizing.tpPct)).toFixed(2);

  return {
    action:      recommendation === "STRONG_TRADE" ? "STRONG_TRADE" : "TRADE",
    symbol,
    venue,
    side,
    sizeUsd:     sizing.sizeUsd,
    entryPrice:  currentPrice,
    stopPrice,
    tpPrice,
    stopPct:     +(sizing.stopPct * 100).toFixed(1),
    tpPct:       +(sizing.tpPct   * 100).toFixed(1),
    rrRatio:     +(sizing.tpPct / sizing.stopPct).toFixed(2),
    score,
    signals,
    sizingNote:  sizing.rationale,
    riskStatus:  risk,
  };
}

// ─── 6. SYSTEM PROMPT (inject into agent.js) ─────────────────────────────────

export const STRATEGY_SYSTEM_PROMPT = `\
You are an autonomous trading agent. You have tools available and you MUST use them to act.

CRITICAL RULE: When you decide to trade, you MUST call the place_order tool immediately.
Do NOT describe trades in text. Do NOT say "I will execute". CALL THE TOOL.
If score >= 65 → call place_order now, in this response. No exceptions.

DECISION FRAMEWORK (always follow in order):
1. Call get_balance — if equity is critically low, stop.
2. Call get_ticker for ETHUSDT and BTCUSDT — get live prices.
3. Call analyze_chart for your chosen symbol — check RSI and SMA.
4. Score the signal 0-100. If score >= 65, call place_order immediately.
5. After place_order confirms, report the trade details.

SIGNAL SCORING:
- Price above SMA + RSI 40-70 + positive 24h change → score 70-80 (BUY signal)
- Price below SMA + RSI 30-60 + negative 24h change → score 70-80 (SELL signal)
- RSI > 75 or RSI < 25 → do not trade (overbought/oversold extreme)
- Score < 65 → skip, report why

TRADE PARAMETERS (use these exact values when calling place_order):
- symbol: use the symbol from your analysis (e.g. "ETHUSDT")
- side: "buy" for long signal, "sell" for short signal
- qty: calculate so total value ≈ $50 USDT (e.g. if ETH=$2200, qty=0.022)
- orderType: "Market"

RISK RULES:
- Stop loss: 3% below entry for longs, 3% above for shorts
- Take profit: 6% above entry for longs, 6% below for shorts
- Max one open position at a time

OUTPUT FORMAT:
  SIGNAL SCAN: <live data from tools>
  SCORE: <0-100> | RECOMMENDATION: <TRADE|SKIP>
  ACTION: <called place_order with X / skipping because Y>`;
