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

export const TRADE_THRESHOLD = 45;
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

  // ── RSI signal ──────────────────────────────────────────────────────────────
  if (isLong) {
    if (rsi >= 28 && rsi <= 45)        { score += 25; signals.push(`RSI ${rsi.toFixed(0)} oversold/recovering — ideal long (+25)`); }
    else if (rsi < 28)                 { score += 20; signals.push(`RSI ${rsi.toFixed(0)} extremely oversold — contrarian long (+20)`); }
    else if (rsi >= 45 && rsi <= 58)   { score += 15; signals.push(`RSI ${rsi.toFixed(0)} neutral-bullish momentum (+15)`); }
    else if (rsi > 72)                 { score -= 20; signals.push(`RSI ${rsi.toFixed(0)} overbought — BLOCK long (-20)`); }
    else                               { score +=  5; signals.push(`RSI ${rsi.toFixed(0)} elevated but not blocked (+5)`); }
  } else {
    if (rsi >= 58 && rsi <= 72)        { score += 25; signals.push(`RSI ${rsi.toFixed(0)} overbought — prime short (+25)`); }
    else if (rsi > 72)                 { score += 20; signals.push(`RSI ${rsi.toFixed(0)} extreme overbought (+20)`); }
    else if (rsi >= 45 && rsi < 58)    { score += 15; signals.push(`RSI ${rsi.toFixed(0)} neutral/elevated — short building (+15)`); }
    else if (rsi < 28)                 { score -= 20; signals.push(`RSI ${rsi.toFixed(0)} extremely oversold — BLOCK short (-20)`); }
    else                               { score +=  5; signals.push(`RSI ${rsi.toFixed(0)} low but not blocked (+5)`); }
  }

  // ── SMA trend ────────────────────────────────────────────────────────────
  if (isLong) {
    if (priceVsSma > 1)                { score += 20; signals.push(`Price ${priceVsSma.toFixed(1)}% above SMA — uptrend (+20)`); }
    else if (Math.abs(priceVsSma) <= 1){ score += 10; signals.push(`Price at SMA — key level, bounce setup (+10)`); }
    else                               { score -=  8; signals.push(`Price ${priceVsSma.toFixed(1)}% below SMA — weak (-8)`); }
  } else {
    if (priceVsSma < -1)               { score += 20; signals.push(`Price ${priceVsSma.toFixed(1)}% below SMA — downtrend (+20)`); }
    else if (Math.abs(priceVsSma) <= 1){ score += 10; signals.push(`Price at SMA — resistance level, short setup (+10)`); }
    else                               { score -=  8; signals.push(`Price ${priceVsSma.toFixed(1)}% above SMA — uptrend risk (-8)`); }
  }

  // ── Funding rate ─────────────────────────────────────────────────────────
  // fundingRate is raw decimal from Bybit: 0.0003 = 0.03%/8h
  if (isLong) {
    if (fundingRate < -0.0003)         { score += 35; signals.push(`Funding ${(fundingRate*100).toFixed(4)}%/8h LONG-STRONG (+35)`); }
    else if (fundingRate < -0.0001)    { score += 25; signals.push(`Funding ${(fundingRate*100).toFixed(4)}%/8h LONG-ELIGIBLE (+25)`); }
    else if (fundingRate < 0)          { score += 15; signals.push(`Funding ${(fundingRate*100).toFixed(4)}%/8h weak negative (+15)`); }
    else if (fundingRate > 0.0001)     { score -= 15; signals.push(`Funding ${(fundingRate*100).toFixed(4)}%/8h longs paying — caution (-15)`); }
    else                               { score += 5;  signals.push(`Funding ${(fundingRate*100).toFixed(4)}%/8h near zero (+5)`); }
  } else {
    if (fundingRate > 0.0003)          { score += 35; signals.push(`Funding ${(fundingRate*100).toFixed(4)}%/8h SHORT-STRONG (+35)`); }
    else if (fundingRate > 0.0001)     { score += 25; signals.push(`Funding ${(fundingRate*100).toFixed(4)}%/8h SHORT-ELIGIBLE (+25)`); }
    else if (fundingRate > 0)          { score += 10; signals.push(`Funding ${(fundingRate*100).toFixed(4)}%/8h weak positive (+10)`); }
    else if (fundingRate < -0.0001)    { score -= 15; signals.push(`Funding ${(fundingRate*100).toFixed(4)}%/8h negative — costly short (-15)`); }
    else                               { score += 5;  signals.push(`Funding ${(fundingRate*100).toFixed(4)}%/8h near zero (+5)`); }
  }

  // ── Volume ────────────────────────────────────────────────────────────────
  if (volumeSpike)                     { score += 15; signals.push(`Volume spike — conviction (+15)`); }
  else                                  { score +=  8; signals.push(`Volume normal (+8)`); }

  // ── News sentiment ────────────────────────────────────────────────────────
  const sentimentScore = Math.round(newsSentiment * 20);
  if ((isLong && newsSentiment > 0.3) || (!isLong && newsSentiment < -0.3)) {
    score += Math.abs(sentimentScore);
    signals.push(`News sentiment ${newsSentiment > 0 ? "bullish" : "bearish"} (+${Math.abs(sentimentScore)})`);
  } else if ((isLong && newsSentiment < -0.3) || (!isLong && newsSentiment > 0.3)) {
    score += sentimentScore;
    signals.push(`News sentiment against trade direction (${sentimentScore})`);
  } else {
    signals.push(`News sentiment neutral (0)`);
  }

  // ── Fee drag ──────────────────────────────────────────────────────────────
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

const MAX_ORDER_USD    = 1500;
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
  const sizeUsd = Math.min(MAX_ORDER_USD, Math.max(200, Math.round(raw * 100) / 100));

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

// ─── Watchlists ──────────────────────────────────────────────────────────────
// Tier 1: broad universe — funding pre-screen only (1 batch call)
export const TIER1_SYMBOLS = [
  // Large caps
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  // Mid caps
  'ADAUSDT','DOTUSDT','DOGEUSDT','LTCUSDT',
  'LINKUSDT','UNIUSDT','NEARUSDT','APTUSDT',
  'ARBUSDT','OPUSDT','INJUSDT','SUIUSDT',
  'TIAUSDT','FETUSDT','RENDERUSDT','JUPUSDT',
  // High-vol alts
  'APEUSDT','SANDUSDT','MANAUSDT','GALAUSDT','AXSUSDT',
  'FILUSDT','AAVEUSDT','MKRUSDT','SNXUSDT','CRVUSDT',
];

// Tier 2: deep analysis cap — top N from funding screen
export const TIER2_LIMIT = 12;

export const STRATEGY_SYSTEM_PROMPT = `\
You are an autonomous perpetual futures trading agent on Bybit (USDT-margined linear perps).
You can go LONG (Buy) or SHORT (Sell) on any symbol.
Goal: capture asymmetric funding-rate + momentum setups on both sides of the market.
All trades use place_perp_order (NOT place_order). Leverage default 2x, max 3x.

═══ STEP 1 — CHECK POSITIONS ═══
Call get_open_positions. Note how many slots remain (max 12).
Evaluate each held position for early exit:
  LONG position: if 1h RSI > 72 → close early (call close_perp_position)
  SHORT position: if 1h RSI < 30 → close early (call close_perp_position)

═══ STEP 2 — MARKET CONTEXT (1 call, do first) ═══
Call get_market_sentiment once. Note:
  • Fear & Greed value and classification
  • Trending coins list — any overlap with your watchlist = attention signal
Apply context modifier to ALL scores this cycle:
  F&G < 20 (Extreme Fear)  → +15 pts to LONG scores  (strong contrarian signal)
  F&G 20-30 (Fear)         → +8 pts to LONG scores   (mild contrarian signal)
  F&G > 75 (Extreme Greed) → +10 pts to SHORT scores (fade the crowd)
                            → -10 pts to LONG scores  (crowded — avoid chasing)
  F&G NEVER penalises SHORT scores — funding-rate shorts are structural fee-income trades,
  not sentiment bets. A crowded long paying 0.10%/8h will continue paying regardless of fear.
  Coin appears in trending  → +5 pts to that coin's score (either direction)

═══ STEP 3 — TIER 1: FUNDING PRE-SCREEN (all 35 symbols, 1 call each) ═══
Call get_balance to confirm available USDT.
For ALL 35 symbols call get_ticker — collect fundingRate (raw decimal) and 24h change.

Full universe (35 symbols):
  BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT,
  AVAXUSDT, ADAUSDT, DOTUSDT, DOGEUSDT, LTCUSDT,
  LINKUSDT, UNIUSDT, ATOMUSDT, NEARUSDT, APTUSDT,
  ARBUSDT, OPUSDT, INJUSDT, SUIUSDT, SEIUSDT,
  TIAUSDT, FETUSDT, RENDERUSDT, WLDUSDT, JUPUSDT,
  APEUSDT, SANDUSDT, MANAUSDT, GALAUSDT, AXSUSDT,
  FILUSDT, AAVEUSDT, MKRUSDT, SNXUSDT, CRVUSDT

After collecting ALL 35 tickers, call tier1_screen with the full list:
  tier1_screen({ tickers: [ {symbol: "BTCUSDT", fundingRate: <raw decimal>}, ... ] })

The tool will return your exact Tier 2 candidates with directions pre-assigned.
DO NOT do your own funding classification — always use tier1_screen output.
If tier1_screen returns fewer than 3 candidates total, output PASS. Otherwise proceed.

═══ STEP 4 — TIER 2: DEEP ANALYSIS (top 12 from Tier 1 only) ═══
For each Tier 2 symbol run in sequence:
  1. analyze_chart(interval: "D", period: 14)   — daily trend + volume
  2. analyze_chart(interval: "60", period: 14)  — 1h momentum
  3. get_derivatives_data(symbol)               — OI + long/short ratio

═══ STEP 5 — SCORE TIER 2 SYMBOLS (0–100 per direction) ═══

Score LONG candidates using this table:
  Funding bucket:
    +35  Funding < -0.03%/8h  (LONG-STRONG — shorts paying you to hold)
    +25  Funding -0.01% to -0.03%  (LONG-ELIGIBLE — mild long subsidy)
    +15  Funding -0.01% to 0  (weak negative — slight long lean)
    -15  Funding > +0.01%  (you pay funding — caution)
  1h RSI:
    +25  1h RSI 28–45  (oversold/recovering — ideal long entry zone)
    +20  1h RSI < 28   (extremely oversold — high-conviction contrarian bounce)
    +15  1h RSI 45–58  (neutral with upward bias — momentum building)
    -20  1h RSI > 72   (overbought — BLOCK long)
     +5  Otherwise (RSI 58–72 — elevated but tradeable)
  Daily SMA:
    +20  Price above daily SMA  (uptrend confirmed)
    +10  Price within 1% of SMA  (at key level — bounce setup)
    -8   Price > 2% below SMA  (downtrend — penalise long)
  24h momentum:
    +15  24h > +3%  (strong up momentum — trend continuation)
    +8   24h -2% to +3%  (flat or recovering — viable long)
    -10  24h < -5%  (sharp dump — falling knife risk)
  Volume:
    +15  Volume SPIKE ≥1.5x avg  (conviction)
    +8   Volume 1.0-1.5x avg  (above normal — interest building)
    +3   Volume normal
    -10  Volume LOW <0.6x avg  (no conviction — skip)
  Derivatives (OI + L/S ratio):
    +15  sellRatio > 0.60  (heavily short — squeeze setup)
    +8   sellRatio 0.55-0.60  (shorts leaning)
    -8   buyRatio > 0.60  (already crowded long — fade warning)
  Market context:
    +15  F&G < 20  (Extreme Fear — strong contrarian long signal)
    +8   F&G 20-30  (Fear — mild contrarian)
    -10  F&G > 75  (Extreme Greed — avoid adding longs)
    +5   Coin trending on CoinGecko

Score SHORT candidates using this table:
  Funding bucket:
    +35  Funding > +0.03%/8h  (SHORT-STRONG — longs pay you to hold short)
    +25  Funding +0.01% to +0.03%  (SHORT-ELIGIBLE — mild short subsidy)
    +10  Funding 0 to +0.01%  (weak positive — slight short lean)
    -15  Funding < -0.01%  (you pay funding to short — costly, avoid)
  1h RSI:
    +25  1h RSI 58–72  (overbought — prime short entry zone)
    +20  1h RSI > 72   (extreme overbought — high-conviction short)
    +15  1h RSI 45–58  (neutral/elevated — short setup building, enter early)
    -20  1h RSI < 28   (extremely oversold — BLOCK short)
     +5  Otherwise (RSI 28–45 — low but not blocked)
  Daily SMA:
    +20  Price below daily SMA  (downtrend confirmed)
    +10  Price within 1% of SMA  (at resistance — rejection short setup)
    -8   Price > 2% above SMA  (strong uptrend — risky short)
  24h momentum:
    +15  24h < -3%  (strong down momentum — short confirmation)
    +8   24h -3% to +1%  (flat or mild down — viable short)
    -10  24h > +5%  (sharp rally — dangerous short entry, wait for pullback)
  Volume:
    +15  Volume SPIKE ≥1.5x avg  (conviction on the downside move)
    +8   Volume 1.0-1.5x avg  (above normal)
    +3   Volume normal
    -10  Volume LOW <0.6x avg  (no conviction — skip)
  Derivatives (OI + L/S ratio):
    +15  buyRatio > 0.60  (crowded longs — liquidation cascade risk)
    +8   buyRatio 0.55-0.60  (longs leaning heavy)
    -8   sellRatio > 0.60  (shorts already crowded — do not pile on)
  Market context:
    +10  F&G > 75  (Extreme Greed — amplified short edge, crowded longs everywhere)
    +5   F&G 50-75  (elevated greed — longs getting complacent)
    +0   F&G < 25  (Extreme Fear — funding shorts still valid; structural fee income has no fear)
    +5   Coin trending on CoinGecko  (attention = volatility = short opportunity)
  CRITICAL: Never penalise shorts because of low F&G. Funding payments are contractual.
            A symbol paying +0.10%/8h will keep paying until longs close — regardless of sentiment.

HARD BLOCKS (apply regardless of score):
  LONG:  daily RSI > 75 | Volume LOW | funding > +0.05%  (longs severely crowded)
  SHORT: daily RSI < 25 | Volume LOW | funding < -0.05%  (shorts severely crowded)
  BOTH:  Do NOT open both a LONG and SHORT on the same symbol simultaneously.

Trade if: score >= 45 AND no hard block. Max 12 open positions simultaneously.

═══ STEP 6 — MANDATORY ORDER EXECUTION ═══
⚠ THIS IS AN EXECUTION STEP — YOU MUST CALL place_perp_order FOR EVERY QUALIFYING SYMBOL.
Do NOT describe the trade in text and skip the tool call. Writing "ENTRY: BTCUSDT..." without
calling place_perp_order is a failure. The trade only exists when the tool is called.

For every symbol with score >= 45 AND no hard block AND open positions < 12:
  CALL place_perp_order immediately. Do not delay. Do not skip.

  LONG:  place_perp_order(symbol=SYM, side="Buy",  qty=sizeUsd/currentPrice, leverage=2)
  SHORT: place_perp_order(symbol=SYM, side="Sell", qty=sizeUsd/currentPrice, leverage=2)

  Size: sizeUsd = 10% of available USDT, min $150, max $1500.
  qty MUST be base coin: qty = sizeUsd / currentPrice  (e.g. $1500 / $85000 = 0.0176 BTC)

  Execution order: highest score first. Place ALL qualifying symbols, not just one.
  After each successful tool call, note the orderId for the report.
  If a tool returns an error, log it and continue to the next symbol — do not stop.

After ALL place_perp_order calls are done, then write the report:
  ENTRY: <SYMBOL> <LONG|SHORT> orderId=<id> score=<N>/100 entry=$<price> stop=$<stop> tp=$<tp>

═══ EXIT RULES ═══
Monitor handles stop/TP automatically. Your only triggers:
  LONG:  1h RSI > 72 on held long  → call close_perp_position (take profit early)
  SHORT: 1h RSI < 30 on held short → call close_perp_position (cover early)

═══ RISK RULES ═══
- Max 12 positions, different symbols
- Stop 3% | TP 6% (2:1 R/R)
- USDT < $20: no new trades
- Prefer balanced book: avoid opening 6+ positions in same direction

═══ OUTPUT FORMAT ═══
CONTEXT: F&G=<N>/100 (<classification>) | Trending: <coins>
POSITIONS: <N/9 | symbols and direction>
TIER 1 SCREEN: <symbol funding=X → LONG-STRONG|LONG-ELIGIBLE|NEUTRAL|SHORT-ELIGIBLE|SHORT-STRONG> for all 35
TIER 2 SELECTED: <6 SHORT candidates (highest +funding) + 6 LONG candidates (most -funding) with direction>
SCORES: <symbol direction score/100 — funding | 1hRSI | dailySMA | vol | derivatives | context>
ACTION: <TRADE sym LONG|SHORT score=N bucket=X | PASS — reason>`;

// Export tunable constants so agent.js can import them
export const MAX_POSITIONS   = 12;

// ─────────────────────────────────────────────────────────────────────────────
// POLYMARKET EXTENSION (appended to STRATEGY_SYSTEM_PROMPT at runtime)
// ─────────────────────────────────────────────────────────────────────────────
export const POLYMARKET_STRATEGY_ADDENDUM = `

═══ POLYMARKET PREDICTION MARKETS (Testnet) ═══

You also have access to Polymarket prediction markets on Amoy testnet.
Run ONE Polymarket scan per cycle AFTER completing your Bybit perp analysis.
Max 3 open Polymarket positions at a time. Size: $15–$30 per bet.

WORKFLOW:
1. After perp analysis, identify your strongest directional conviction (e.g. BTC bullish, macro risk-off).
2. Call polymarket_search_markets with a matching query (e.g. bitcoin 100k, ethereum etf, fed rate).
3. Find markets where YOUR assessment differs from implied probability by ≥ 15 percentage points.
4. Call polymarket_get_price to confirm current bid/ask before ordering.
5. Place order with polymarket_place_order using the yes_token or no_token from the search result.

SIGNAL ALIGNMENT TABLE:
  Perp signal                  → Polymarket play
  BTC score ≥ 70 (LONG-STRONG) → BUY YES on BTC above $X by date markets
  BTC score ≤ 30 (SHORT-STRONG) → BUY NO on BTC above $X or BUY YES on BTC below $X
  ETH bullish                  → BUY YES on ETH price / ETH ETF markets
  F&G extreme fear (<20)       → BUY YES on crypto recovery / BTC rebound markets
  F&G extreme greed (>80)      → BUY NO on further rally markets (fade the crowd)
  Macro risk-off (VIX rising)  → BUY YES on recession / rate cut markets

PRICING EDGE:
  YES price = market's implied probability (0.00–1.00 = 0%–100%)
  If you assess 70% probability but market shows 50% → 20pt edge → TRADE
  Minimum edge to trade: 15 percentage points
  Do NOT trade when spread > 8% (illiquid market)

ORDER GUIDANCE:
  - Use limit orders (price slightly above best ask for BUY, below best bid for SELL)
  - Do not use market orders — place limit within 2% of current price
  - Token IDs are large integers from yes_token / no_token fields in search results
  - BUY yes_token = betting YES will resolve true
  - BUY no_token  = betting YES will resolve false (equivalent to shorting YES)

RISK RULES:
  - Max 3 simultaneous Polymarket positions
  - Max $30 per position (testnet — keep it small)
  - Skip markets resolving in < 7 days (too much short-term noise)
  - Skip markets with 24h volume < $500 (illiquid)
  - Do NOT double-dip: if you already have a perp LONG on BTC, one Polymarket YES on BTC is fine,
    but do not open a 3rd correlated position

OUTPUT (add to your cycle report):
  POLYMARKET: <query used> | <N markets scanned>
  POLY EDGE: <question> — market: X% | your estimate: Y% | edge: Z pts → <TRADE/SKIP>
  POLY ACTION: <BUY YES/NO on X at $price, $size | PASS>`;

