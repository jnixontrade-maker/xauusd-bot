// ============================================================
// TELEGRAM ALERT SENDER
// Sends rich trade signal messages to your Telegram chat
// ============================================================

const fetch = require('node-fetch');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function formatSignalMessage(result) {
  const { price, direction, confluence, pattern, levels, scores, session, sweep, choch } = result;
  const dir = direction === 'long' ? '🟢 BUY LONG' : '🔴 BUY SHORT';
  const urgency = confluence >= 95 ? '🚨🚨 ELITE' : confluence >= 90 ? '🔥 PREMIUM' : '⚡ HIGH';
  const sessText = session.overlap ? 'London+NY Overlap ⚡' : session.london ? 'London' : session.ny ? 'New York' : 'Extended hours';
  const now = new Date().toUTCString().slice(17, 22) + ' UTC';

  return `${urgency} SIGNAL — ${confluence}% CONFLUENCE

${dir}  |  ${sessText}  |  ${now}
Pattern: *${pattern}*

📍 LEVELS
\`Entry:  ${levels.entry.toFixed(2)}\`
\`SL:     ${levels.sl.toFixed(2)}\`
\`BE:     ${levels.be.toFixed(2)}\`  ← move SL here at TP1
\`TP1:    ${levels.tp1.toFixed(2)}\`  ← close 50%
\`TP2:    ${levels.tp2.toFixed(2)}\`  ← full close

📊 SCORE: ${scores.sweep}/35 sweep · ${scores.choch}/20 CHoCH · ${scores.fvg}/20 FVG · ${scores.session}/20 session

${sweep.bsl ? '✅ BSL swept' : sweep.ssl ? '✅ SSL swept' : '➖ No sweep'} · ${choch.confirmed ? '✅ 15M CHoCH' : choch.forming ? '⚠️ CHoCH forming' : '➖ No CHoCH'} · ${scores.fvg >= 12 ? '✅ FVG zone' : '➖ No FVG'}

⚠️ _Phase plan risk only. 3 losses = stop._`;
}
}

async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram] Not configured — skipping alert');
    console.log('[Telegram] Message would be:\n', message);
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const d = await r.json();
    if (d.ok) {
      console.log('[Telegram] Alert sent ✅');
      return true;
    } else {
      console.error('[Telegram] Error:', d.description);
      return false;
    }
  } catch (e) {
    console.error('[Telegram] Fetch error:', e.message);
    return false;
  }
}

async function sendAlert(result) {
  const msg = formatSignalMessage(result);
  return sendTelegram(msg);
}

async function sendStartupMessage() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const msg = `🚀 *XAUUSD Bot Online*\n\nScanning every 5 minutes during London + NY sessions.\nAlerts fire at 85%+ confluence only.\n\n_Mission: £20 → £1,000_`;
  return sendTelegram(msg);
}

module.exports = { sendAlert, sendStartupMessage };
