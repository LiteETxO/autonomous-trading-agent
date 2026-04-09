/**
 * notify.js
 * Telegram + Slack notifications for the autonomous trading agent
 *
 * Setup:
 *   Telegram:
 *     1. Message @BotFather → /newbot → copy the token
 *     2. Send any message to your bot, then visit:
 *        https://api.telegram.org/bot<TOKEN>/getUpdates
 *        Copy the chat.id from the response
 *     Set env vars:
 *        TELEGRAM_BOT_TOKEN=xxx
 *        TELEGRAM_CHAT_ID=yyy
 *
 *   Slack:
 *     1. Create an Incoming Webhook at https://api.slack.com/apps
 *     2. Copy the webhook URL
 *     Set env vars:
 *        SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
 */

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const SLACK_WEBHOOK  = process.env.SLACK_WEBHOOK_URL;

// ─── Internal send helpers ────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  }).catch((e) => console.warn("[notify] Telegram error:", e.message));
}

async function sendSlack(text, blocks) {
  if (!SLACK_WEBHOOK) return;
  await fetch(SLACK_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(blocks ? { text, blocks } : { text }),
  }).catch((e) => console.warn("[notify] Slack error:", e.message));
}

// ─── Public notification events ───────────────────────────────────────────────

/**
 * Agent started a new task.
 */
export async function notifyTaskStart(task) {
  const msg = `🤖 <b>Agent started</b>\n<code>${task}</code>`;
  await sendTelegram(msg);
  await sendSlack(`🤖 *Agent started*\n>${task}`, [
    {
      type: "section",
      text: { type: "mrkdwn", text: `🤖 *Agent started*\n>${task}` },
    },
  ]);
}

/**
 * Agent decided to place a trade.
 */
export async function notifyTrade({ symbol, side, qty, orderType, price, orderId, testnet }) {
  const env   = testnet ? " (TESTNET)" : "";
  const value = price ? `$${(qty * price).toFixed(2)}` : `${qty} ${symbol.replace("USDT","")}`;
  const emoji = side.toLowerCase() === "buy" ? "🟢" : "🔴";

  const tgMsg = [
    `${emoji} <b>Trade executed${env}</b>`,
    `Symbol : <code>${symbol}</code>`,
    `Side   : <b>${side.toUpperCase()}</b>`,
    `Qty    : ${qty}`,
    `Type   : ${orderType}`,
    price ? `Price  : $${price}` : null,
    `Value  : ${value}`,
    orderId ? `OrderID: <code>${orderId}</code>` : null,
  ].filter(Boolean).join("\n");

  await sendTelegram(tgMsg);

  await sendSlack(`${emoji} Trade executed${env}`, [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} Trade executed${env}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Symbol*\n${symbol}` },
        { type: "mrkdwn", text: `*Side*\n${side.toUpperCase()}` },
        { type: "mrkdwn", text: `*Qty*\n${qty}` },
        { type: "mrkdwn", text: `*Value*\n${value}` },
        ...(price ? [{ type: "mrkdwn", text: `*Price*\n$${price}` }] : []),
        ...(orderId ? [{ type: "mrkdwn", text: `*Order ID*\n\`${orderId}\`` }] : []),
      ],
    },
  ]);
}

/**
 * Agent decided to pass (no trade).
 */
export async function notifyPass(reason) {
  const msg = `⏭ <b>Agent passed</b>\n${reason}`;
  await sendTelegram(msg);
  await sendSlack(`⏭ *Agent passed*\n>${reason}`);
}

/**
 * Agent encountered an error.
 */
export async function notifyError(error) {
  const msg = `❌ <b>Agent error</b>\n<code>${error}</code>`;
  await sendTelegram(msg);
  await sendSlack(`❌ *Agent error*\n>${error}`);
}

/**
 * Order rejected by the position-size guard.
 */
export async function notifyRejected({ symbol, estimatedValue, maxAllowed }) {
  const msg = `🚫 <b>Order rejected (size guard)</b>\n${symbol} · $${estimatedValue.toFixed(2)} > $${maxAllowed} limit`;
  await sendTelegram(msg);
  await sendSlack(`🚫 *Order rejected* — ${symbol} estimated $${estimatedValue.toFixed(2)} exceeds $${maxAllowed} limit`);
}

/**
 * Generic agent step — used for important reasoning milestones.
 * Keep quiet by default (only logs, doesn't ping every step).
 */
export async function notifyStep(label, detail) {
  // Intentionally lightweight — comment out sendTelegram if too noisy
  console.log(`[notify] ${label}: ${detail}`);
}
