const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const TWELVE_KEY = process.env.TWELVE_KEY || 'e3c9496f7f9548d58aae0e3310893b1d';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

let lastAnalysis = null;
let lastAlertTime = null;
let analysisHistory = [];
const COOLDOWN = 3 * 60 * 1000;

async function fetchCandles(interval, size = 60) {
  try {
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${size}&apikey=${TWELVE_KEY}`);
    const d = await r.json();
    return d.values || null;
  } catch (e) { return null; }
}

function calcEMA(candles, period) {
  if (!candles || candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = parseFloat(candles[candles.length - 1].close);
  for (let i = candles.length - 2; i >= 0; i--)
    ema = parseFloat(candles[i].close) * k + ema * (1 - k);
  return ema;
}

function detectFVGs(candles, limit = 25) {
  const fvgs = [];
  for (let i = 1; i < Math.min(candles.length - 1, limit); i++) {
    const pH = parseFloat(candles[i+1].high), pL = parseFloat(candles[i+1].low);
    const nH = parseFloat(candles[i-1].high), nL = parseFloat(candles[i-1].low);
    const body = Math.abs(parseFloat(candles[i].close) - parseFloat(candles[i].open));
    if (pH < nL && body > 2) fvgs.push({ type: 'bull', low: pH, high: nL });
    if (pL > nH && body > 2) fvgs.push({ type: 'bear', low: nH, high: pL });
  }
  return fvgs;
}

function detectSwings(candles, lb = 35) {
  const highs = [], lows = [];
  for (let i = 2; i < Math.min(candles.length - 2, lb); i++) {
    const h = parseFloat(candles[i].high), l = parseFloat(candles[i].low);
    if (h > parseFloat(candles[i-1].high) && h > parseFloat(candles[i+1].high) &&
        h > parseFloat(candles[i-2].high) && h > parseFloat(candles[i+2].high)) highs.push(h);
    if (l < parseFloat(candles[i-1].low) && l < parseFloat(candles[i+1].low) &&
        l < parseFloat(candles[i-2].low) && l < parseFloat(candles[i+2].low)) lows.push(l);
  }
  return { highs, lows };
}

function detectSweep(candles) {
  const { highs, lows } = detectSwings(candles);
  const latest = parseFloat(candles[0].high);
  const latestLow = parseFloat(candles[0].low);
  const latestClose = parseFloat(candles[0].close);
  const bslLevel = highs.length ? Math.max(...highs) : null;
  const sslLevel = lows.length ? Math.min(...lows) : null;
  return {
    bslSwept: bslLevel && latest > bslLevel && latestClose < bslLevel,
    sslSwept: sslLevel && latestLow < sslLevel && latestClose > sslLevel,
    bslLevel, sslLevel
  };
}

function detectCHoCH(candles, dir, limit = 15) {
  if (!candles || candles.length < 5) return false;
  const r = candles.slice(0, limit);
  if (dir === 'bear') return parseFloat(candles[0].close) < Math.min(...r.map(c => parseFloat(c.low))) * 1.002;
  return parseFloat(candles[0].close) > Math.max(...r.map(c => parseFloat(c.high))) * 0.998;
}

function getSession() {
  const h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
  const mins = h * 60 + m;
  return {
    london: mins >= 480 && mins < 1020,
    ny: mins >= 780 && mins < 1320,
    overlap: mins >= 780 && mins < 1020
  };
}

async function runAnalysis() {
  const [d1m, d15m, d1h, d4h] = await Promise.all([
    fetchCandles('1min'), fetchCandles('15min'),
    fetchCandles('1h'), fetchCandles('4h')
  ]);
  if (!d1m || !d15m || !d1h || !d4h) return null;

  const price = parseFloat(d1m[0].close);
  const e20_4h = calcEMA(d4h, 20), e50_4h = calcEMA(d4h, 50);
  const e20_1h = calcEMA(d1h, 20), e50_1h = calcEMA(d1h, 50);
  const e20_15m = calcEMA(d15m, 20);
  const b4h = price > e20_4h && e20_4h > e50_4h ? 1 : price < e20_4h && e20_4h < e50_4h ? -1 : 0;
  const b1h = price > e20_1h && e20_1h > e50_1h ? 1 : price < e20_1h && e20_1h < e50_1h ? -1 : 0;
  const b15m = price > e20_15m ? 1 : -1;

  const sw1h = detectSweep(d1h), sw4h = detectSweep(d4h);
  let direction = null, sweepScore = 0;
  if (sw4h.bslSwept) { direction = 'short'; sweepScore = 35; }
  else if (sw1h.bslSwept) { direction = 'short'; sweepScore = 25; }
  else if (sw4h.sslSwept) { direction = 'long'; sweepScore = 35; }
  else if (sw1h.sslSwept) { direction = 'long'; sweepScore = 25; }
  else if (b4h === 1 && b1h === 1) { direction = 'long'; sweepScore = 10; }
  else if (b4h === -1 && b1h === -1) { direction = 'short'; sweepScore = 10; }

  const cd = direction === 'short' ? 'bear' : 'bull';
  const c15m = detectCHoCH(d15m, cd), c1m = detectCHoCH(d1m, cd);
  const chochScore = c15m ? 20 : c1m ? 12 : 0;

  const ft = direction === 'short' ? 'bear' : 'bull';
  const fg = detectFVGs(d1h).filter(f => f.type === ft).length +
             detectFVGs(d15m).filter(f => f.type === ft).length;
  const fvgScore = Math.min(fg * 12, 20);
  const trendScore = (Math.abs(b4h) * 15) + ((b4h === b1h && b1h !== 0) ? 15 : 5);
  const sess = getSession();
  const sessScore = sess.overlap ? 20 : (sess.london || sess.ny) ? 14 : 0;
  const tfBonus = [b4h, b1h, b15m].every(b => direction === 'long' ? b >= 0 : b <= 0) ? 10 : 0;
  const total = Math.min(100, sweepScore + chochScore + fvgScore + trendScore + sessScore + tfBonus);

  const sl = 15;
  const slPrice = direction === 'long' ? price - sl : price + sl;
  const be = direction === 'long' ? price + sl : price - sl;
  const tp1 = direction === 'long' ? price + sl * 2 : price - sl * 2;
  const tp2 = direction === 'long' ? price + sl * 3 : price - sl * 3;

  let pattern = 'Trend Follow';
  if (sweepScore >= 35 && chochScore >= 20) pattern = 'Expansion Model';
  else if (sweepScore >= 25 && direction === 'short') pattern = 'BSL Sweep Short';
  else if (sweepScore >= 25 && direction === 'long') pattern = 'SSL Sweep Long';
  else if (fvgScore >= 16) pattern = 'FVG + IFVG';

  const shouldAlert = direction !== null &&
    ((total >= 85 && (sess.london || sess.ny)) || total >= 90);

  console.log(`[${new Date().toISOString()}] ${price} | ${direction} | ${total}% | alert:${shouldAlert}`);
  return {
    timestamp: new Date().toISOString(), price, direction, confluence: total,
    pattern, shouldAlert, session: sess,
    sweep: { bsl: sw4h.bslSwept || sw1h.bslSwept, ssl: sw4h.sslSwept || sw1h.sslSwept },
    choch: { confirmed: c15m, forming: c1m },
    scores: { sweep: sweepScore, choch: chochScore, fvg: fvgScore, trend: trendScore, session: sessScore, tfBonus },
    levels: { entry: price, sl: slPrice, be, tp1, tp2 }
  };
}

async function sendTelegram(result) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const { price, direction, confluence, pattern, levels, session } = result;
  const dir = direction === 'long' ? '🟢 BUY LONG' : '🔴 BUY SHORT';
  const sess = session.overlap ? 'London+NY ⚡' : session.london ? 'London' : 'New York';
  const now = new Date().toUTCString().slice(17, 22) + ' UTC';
  const msg = `${confluence >= 90 ? '🔥' : '⚡'} *XAUUSD ${confluence}% SIGNAL*\n\n${dir} | ${sess} | ${now}\n*${pattern}*\n\`Entry: ${levels.entry.toFixed(2)}\`\n\`SL:    ${levels.sl.toFixed(2)}\`\n\`TP1:   ${levels.tp1.toFixed(2)}\`\n\`TP2:   ${levels.tp2.toFixed(2)}\`\n\n_3 losses = stop. Phase plan risk only._`;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
    });
    console.log('[Telegram] Alert sent');
  } catch (e) { console.error('[Telegram] Error:', e.message); }
}

function canAlert(result) {
  if (!lastAlertTime) return true;
  if (lastAlertTime.direction !== result.direction) return true;
  return Date.now() - lastAlertTime.time > COOLDOWN;
}

async function scan() {
  const result = await runAnalysis();
  if (!result) return;
  lastAnalysis = result;
  analysisHistory.unshift(result);
  if (analysisHistory.length > 200) analysisHistory.pop();
  if (result.shouldAlert && canAlert(result)) {
    await sendTelegram(result);
    lastAlertTime = { time: Date.now(), direction: result.direction };
  }
}

// Every 1 min during London+NY (08:00-22:00 UTC Mon-Fri)
cron.schedule('* 8-22 * * 1-5', scan, { timezone: 'UTC' });
// Every 14 min self-ping to stay awake
cron.schedule('*/14 * * * *', () => {
  fetch(`http://localhost:${PORT}/api/health`).catch(() => {});
});

app.get('/api/signal', (req, res) => {
  if (!lastAnalysis) return res.json({ shouldAlert: false, confluence: 0, direction: null, entry: 0, sl: 0, be: 0, tp1: 0, tp2: 0, pattern: '', timestamp: new Date().toISOString() });
  const a = lastAnalysis;
  res.json({ shouldAlert: a.shouldAlert, confluence: a.confluence, direction: a.direction, entry: a.levels.entry, sl: a.levels.sl, be: a.levels.be, tp1: a.levels.tp1, tp2: a.levels.tp2, pattern: a.pattern, timestamp: a.timestamp, sessionOk: a.session.london || a.session.ny });
});

app.get('/api/latest', (req, res) => res.json({ analysis: lastAnalysis, history: analysisHistory.slice(0, 20), serverTime: new Date().toISOString() }));
app.get('/api/analyse', async (req, res) => { await scan(); res.json({ ok: true, analysis: lastAnalysis }); });
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.listen(PORT, async () => {
  console.log(`🚀 XAUUSD Bot running on port ${PORT}`);
  console.log(`Telegram: ${TELEGRAM_TOKEN ? '✅' : '⚠️ not configured'}`);
  await scan();
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: '🚀 *XAUUSD Bot Online* — scanning every 1 min during London+NY', parse_mode: 'Markdown' })
    });
  } catch (e) {}
});
