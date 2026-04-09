# Autonomous Trading Agent

Powered by Claude Opus 4.6. Trades crypto and prediction markets across Bybit,
Hyperliquid, Uniswap v3, dYdX v4, GMX v2, and Polymarket.

## Files

| File | Purpose |
|---|---|
| `agent.js` | Main agent loop (Claude Opus 4.6, adaptive thinking) |
| `strategy.js` | Signal scoring, Kelly sizing, risk management |
| `bybit-agent-tools.js` | Bybit CEX — spot trading |
| `dex-agent-tools.js` | Hyperliquid · Uniswap · dYdX · GMX |
| `position-monitor.js` | Watches open positions, fires on close |
| `performance-tracker.js` | Logs outcomes, detects divergence |
| `adaptive.js` | Walk-forward param optimizer |
| `backtest.js` | Historical backtesting on real Bybit data |
| `notify.js` | Telegram + Slack notifications |

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in your keys
cp .env.example .env
nano .env

# 3. Run a backtest first (no keys needed for market data)
npm run backtest

# 4. Start on testnet
npm start

# 5. Watch logs
pm2 logs
```

## Commands

```bash
npm start          # agent + monitor together (via PM2)
npm run agent      # agent only
npm run monitor    # position monitor only
npm run backtest   # backtest on ETHUSDT daily, 365 days
npm run adaptive   # force a parameter re-evaluation
npm run check      # same as adaptive
```

## Safety

- All testnets are ON by default. Flip `*_TESTNET=false` only when ready.
- Max position size: $100 USDT (enforced in tool layer, not just prompt).
- Daily circuit breaker: −8% stops trading for 24h.
- Peak drawdown kill switch: −15% requires manual restart.
- Adaptive param changes > 10% require approval window.

## Deployment

See the deployment guide in Mission Control, or:

```bash
# On your VPS (Ubuntu 24.04)
npm install -g pm2
pm2 start position-monitor.js --name monitor
pm2 start agent.js --name agent --cron "*/30 * * * *" --no-autorestart
pm2 save && pm2 startup
```
