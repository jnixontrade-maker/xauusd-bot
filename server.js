// ============================================================
// XAUUSD SMC SCALP ANALYZER — SERVER v3.1
// Express + node-cron background scanner + Telegram alerts
// Deploy to Render.com (free tier)
// ============================================================

const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { runAnalysis } = require('./analyser');
const { sendAlert, sendStartupMessage } = require('./telegram');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the frontend
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// ── STATE ──
let lastAnalysis = null;
let lastAlertTime = null;
let analysisHistory = [];
// 24HR MISSION MODE: 3 min cooldown only — catch every valid setup
const ALERT_COOLDOWN_MS = 3 * 60 * 1000;

// ── API ENDPOINTS ──

// GET /api/latest — frontend polls this every 15s
app.get('/api/latest', (req, res) => {
  res.json({
    analysis: lastAnalysis,
    history: analysisHistory.slice(0, 20),
    serverTime: new Date().toISOString(),
  });
});

// GET /api/analyse — manual trigger (also called by frontend Analyse button)
app.get('/api/analyse', async (req, res) => {
  try {
    const result = await runAnalysis();
    if (result) {
      lastAnalysis = result;
      analysisHistory.unshift(result);
      if (analysisHistory.length > 100) analysisHistory.pop();

      if (result.shouldAlert && canSendAlert(result)) {
        await sendAlert(result);
        lastAlertTime = { time: Date.now(), direction: result.direction };
      }
    }
    res.json({ ok: true, analysis: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/signal — MT5 EA polls this. Flat JSON, no nesting for easy parsing.
app.get('/api/signal', (req, res) => {
  if (!lastAnalysis) {
    return res.json({
      shouldAlert: false, confluence: 0, direction: null,
      entry: 0, sl: 0, be: 0, tp1: 0, tp2: 0,
      pattern: '', timestamp: new Date().toISOString()
    });
  }
  const a = lastAnalysis;
  // Flat structure — MQL5 string parsing is easier without deep nesting
  res.json({
    shouldAlert:  a.shouldAlert,
    confluence:   a.confluence,
    direction:    a.direction,
    entry:        a.levels?.entry  || 0,
    sl:           a.levels?.sl     || 0,
    be:           a.levels?.be     || 0,
    tp1:          a.levels?.tp1    || 0,
    tp2:          a.levels?.tp2    || 0,
    pattern:      a.pattern        || '',
    timestamp:    a.timestamp,
    sessionOk:    a.session?.london || a.session?.ny || false,
    bslSwept:     a.sweep?.bsl     || false,
    sslSwept:     a.sweep?.ssl     || false,
    chochConfirmed: a.choch?.confirmed || false,
  });
});

// GET /api/health — Render keep-alive ping
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), lastAnalysis: lastAnalysis?.timestamp });
});

// POST /api/config — update Telegram credentials at runtime (optional)
app.post('/api/config', (req, res) => {
  const { token, chatId } = req.body;
  if (token) process.env.TELEGRAM_TOKEN = token;
  if (chatId) process.env.TELEGRAM_CHAT_ID = chatId;
  res.json({ ok: true, message: 'Config updated' });
});

// ── ALERT COOLDOWN ──
// 24HR MISSION MODE: 3 min cooldown — new direction always fires immediately
function canSendAlert(result) {
  if (!lastAlertTime) return true;
  const timeSince = Date.now() - lastAlertTime.time;
  // Always fire immediately if direction flipped (new setup)
  if (lastAlertTime.direction !== result.direction) return true;
  // Same direction: wait only 3 minutes to avoid duplicate pings on same candle
  if (timeSince < ALERT_COOLDOWN_MS) {
    console.log(`[Alert] Cooldown: ${Math.round((ALERT_COOLDOWN_MS - timeSince) / 1000)}s remaining`);
    return false;
  }
  return true;
}

// ── CRON SCHEDULE ──
// 24HR MISSION: scan every 1 minute during ALL session hours (08:00–22:00 UTC Mon–Fri)
// Alert threshold: 85%+ confluence. Cooldown: 3 min same direction only.
cron.schedule('* 8-22 * * 1-5', async () => {
  console.log(`[Cron] 1-min scan — ${new Date().toISOString()}`);
  try {
    const result = await runAnalysis();
    if (result) {
      lastAnalysis = result;
      analysisHistory.unshift(result);
      if (analysisHistory.length > 200) analysisHistory.pop();

      if (result.shouldAlert && canSendAlert(result)) {
        console.log(`[Cron] 🔥 SIGNAL ${result.confluence}% ${result.direction?.toUpperCase()} — alerting`);
        await sendAlert(result);
        lastAlertTime = { time: Date.now(), direction: result.direction };
      }
    }
  } catch (e) {
    console.error('[Cron] Error:', e.message);
  }
}, { timezone: 'UTC' });

// Also scan outside main hours in case of early London or late NY moves
// Lighter scan: every 5 min during 06:00–08:00 and 22:00–23:59 UTC
cron.schedule('*/5 6-7,22-23 * * 1-5', async () => {
  try {
    const result = await runAnalysis();
    if (result && result.confluence >= 90 && canSendAlert(result)) {
      // Only fire outside hours if VERY high confluence (90%+)
      console.log(`[Cron-ext] 90%+ signal outside main hours — alerting`);
      await sendAlert(result);
      lastAlertTime = { time: Date.now(), direction: result.direction };
    }
    if (result) { lastAnalysis = result; analysisHistory.unshift(result); }
  } catch (e) { /* silent */ }
}, { timezone: 'UTC' });

// Self-ping every 14 minutes to prevent Render free tier sleep
cron.schedule('*/14 * * * *', async () => {
  try {
    const fetch = require('node-fetch');
    const url = process.env.RENDER_URL || `http://localhost:${PORT}`;
    await fetch(`${url}/api/health`);
    console.log('[Ping] Self-ping OK');
  } catch (e) {
    // Silent — expected to sometimes fail
  }
});

// ── START ──
app.listen(PORT, async () => {
  console.log(`\n🚀 XAUUSD SMC Analyzer v3.1 running on port ${PORT}`);
  console.log(`   Telegram: ${process.env.TELEGRAM_TOKEN ? '✅ Configured' : '⚠️  Not configured — set TELEGRAM_TOKEN + TELEGRAM_CHAT_ID'}`);
  console.log(`   Cron: Scanning every 5min during London+NY sessions (Mon–Fri)`);
  console.log(`   Alert threshold: 85%+ confluence\n`);

  // Run initial analysis
  try {
    const result = await runAnalysis();
    if (result) {
      lastAnalysis = result;
      analysisHistory.push(result);
    }
  } catch (e) {
    console.error('Initial analysis failed:', e.message);
  }

  // Send startup Telegram message
  await sendStartupMessage();
});

module.exports = app;
