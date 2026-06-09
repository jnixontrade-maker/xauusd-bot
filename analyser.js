// ============================================================
// XAUUSD SMC ANALYSIS ENGINE v3.1
// Strategies: BSL Sweep, SSL Sweep, FVG/IFVG, Expansion Model
// Only fires Telegram alert at 85%+ confluence
// ============================================================

const fetch = require('node-fetch');
const TWELVE_KEY = process.env.TWELVE_KEY || 'e3c9496f7f9548d58aae0e3310893b1d';

async function fetchCandles(interval, size = 60) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${size}&apikey=${TWELVE_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    return d.values || null;
  } catch (e) {
    console.error(`fetchCandles(${interval}) error:`, e.message);
    return null;
  }
}

function calcEMA(candles, period) {
  if (!candles || candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = parseFloat(candles[candles.length - 1].close);
  for (let i = candles.length - 2; i >= 0; i--) {
    ema = parseFloat(candles[i].close) * k + ema * (1 - k);
  }
  return ema;
}

function detectSwingHighsLows(candles, lookback = 30) {
  const highs = [], lows = [];
  const limit = Math.min(candles.length - 2, lookback);
  for (let i = 2; i < limit; i++) {
    const h = parseFloat(candles[i].high);
    const l = parseFloat(candles[i].low);
    if (h > parseFloat(candles[i-1].high) && h > parseFloat(candles[i+1].high) &&
        h > parseFloat(candles[i-2].high) && h > parseFloat(candles[i+2].high)) {
      highs.push({ price: h, idx: i });
    }
    if (l < parseFloat(candles[i-1].low) && l < parseFloat(candles[i+1].low) &&
        l < parseFloat(candles[i-2].low) && l < parseFloat(candles[i+2].low)) {
      lows.push({ price: l, idx: i });
    }
  }
  return { highs, lows };
}

function detectFVGs(candles, limit = 25) {
  const fvgs = [];
  for (let i = 1; i < Math.min(candles.length - 1, limit); i++) {
    const prev = candles[i + 1], curr = candles[i], next = candles[i - 1];
    const pH = parseFloat(prev.high), pL = parseFloat(prev.low);
    const nH = parseFloat(next.high), nL = parseFloat(next.low);
    const bodySize = Math.abs(parseFloat(curr.close) - parseFloat(curr.open));
    if (pH < nL && bodySize > 2) fvgs.push({ type: 'bull', low: pH, high: nL, age: i, bodySize });
    if (pL > nH && bodySize > 2) fvgs.push({ type: 'bear', low: nH, high: pL, age: i, bodySize });
  }
  return fvgs;
}

function detectCHoCH(candles, direction, limit = 15) {
  if (!candles || candles.length < 5) return false;
  const recent = candles.slice(0, limit);
  if (direction === 'bear') {
    // Price swept a high then closed below recent swing low = bearish CHoCH
    const recentLow = Math.min(...recent.map(c => parseFloat(c.low)));
    return parseFloat(candles[0].close) < recentLow * 1.002;
  } else {
    const recentHigh = Math.max(...recent.map(c => parseFloat(c.high)));
    return parseFloat(candles[0].close) > recentHigh * 0.998;
  }
}

function detectBSLSSLSweep(candles) {
  const { highs, lows } = detectSwingHighsLows(candles, 40);
  const latest = parseFloat(candles[0].high);
  const latestLow = parseFloat(candles[0].low);
  const latestClose = parseFloat(candles[0].close);

  let bslSwept = false, sslSwept = false;
  let bslLevel = null, sslLevel = null;

  if (highs.length > 0) {
    bslLevel = Math.max(...highs.map(h => h.price));
    // Swept = wick above BSL but closed below it (stop hunt)
    bslSwept = latest > bslLevel && latestClose < bslLevel;
  }
  if (lows.length > 0) {
    sslLevel = Math.min(...lows.map(l => l.price));
    sslSwept = latestLow < sslLevel && latestClose > sslLevel;
  }
  return { bslSwept, sslSwept, bslLevel, sslLevel };
}

function getSession() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const mins = h * 60 + m;
  const london = mins >= 8 * 60 && mins < 17 * 60;
  const ny = mins >= 13 * 60 && mins < 22 * 60;
  const asian = mins < 9 * 60 || mins >= 23 * 60;
  return { london, ny, asian, overlap: london && ny };
}

// ── MAIN ANALYSIS ──
async function runAnalysis() {
  console.log(`[${new Date().toISOString()}] Running analysis...`);

  const [d1m, d15m, d1h, d4h] = await Promise.all([
    fetchCandles('1min', 60),
    fetchCandles('15min', 60),
    fetchCandles('1h', 60),
    fetchCandles('4h', 60),
  ]);

  if (!d1m || !d15m || !d1h || !d4h) {
    console.log('Incomplete data, skipping.');
    return null;
  }

  const price = parseFloat(d1m[0].close);

  // ── EMA trend per TF ──
  const ema20_4h = calcEMA(d4h, 20), ema50_4h = calcEMA(d4h, 50);
  const ema20_1h = calcEMA(d1h, 20), ema50_1h = calcEMA(d1h, 50);
  const ema20_15m = calcEMA(d15m, 20);

  const bias4h = price > ema20_4h && ema20_4h > ema50_4h ? 1 : price < ema20_4h && ema20_4h < ema50_4h ? -1 : 0;
  const bias1h = price > ema20_1h && ema20_1h > ema50_1h ? 1 : price < ema20_1h && ema20_1h < ema50_1h ? -1 : 0;
  const bias15m = price > ema20_15m ? 1 : -1;

  // ── BSL/SSL sweeps on 1H and 4H ──
  const sweep1h = detectBSLSSLSweep(d1h);
  const sweep4h = detectBSLSSLSweep(d4h);

  // ── FVGs ──
  const fvgs1h = detectFVGs(d1h);
  const fvgs15m = detectFVGs(d15m);

  // ── Determine direction ──
  let direction = null;
  let sweepScore = 0;

  if (sweep4h.bslSwept || sweep1h.bslSwept) {
    if (bias4h <= 0 || sweep4h.bslSwept) { direction = 'short'; sweepScore = sweep4h.bslSwept ? 35 : 25; }
  }
  if (sweep4h.sslSwept || sweep1h.sslSwept) {
    if (bias4h >= 0 || sweep4h.sslSwept) { direction = 'long'; sweepScore = sweep4h.sslSwept ? 35 : 25; }
  }
  if (!direction) {
    if (bias4h === 1 && bias1h === 1) direction = 'long';
    else if (bias4h === -1 && bias1h === -1) direction = 'short';
  }

  // ── CHoCH ──
  const chochDir = direction === 'short' ? 'bear' : 'bull';
  const choch15m = detectCHoCH(d15m, chochDir);
  const choch1m = detectCHoCH(d1m, chochDir);
  const chochScore = choch15m ? 20 : choch1m ? 12 : 0;

  // ── FVG/IFVG score ──
  const fvgTarget = direction === 'short' ? 'bear' : 'bull';
  const fvgCount = fvgs1h.filter(f => f.type === fvgTarget).length + fvgs15m.filter(f => f.type === fvgTarget).length;
  const fvgScore = Math.min(fvgCount * 12, 20);

  // ── Trend alignment score ──
  const trendScore =
    (Math.abs(bias4h) * 15) +
    ((bias4h === bias1h && bias1h !== 0) ? 15 : 5);

  // ── Session score ──
  const sess = getSession();
  const sessScore = sess.overlap ? 20 : (sess.london || sess.ny) ? 14 : sess.asian ? 0 : 5;

  // ── Timeframe alignment bonus ──
  const tfAligned = [bias4h, bias1h, bias15m].every(b => direction === 'long' ? b >= 0 : b <= 0);
  const tfBonus = tfAligned ? 10 : 0;

  const total = Math.min(100, sweepScore + chochScore + fvgScore + trendScore + sessScore + tfBonus);

  // ── Levels ──
  const slPips = 15;
  const sl = direction === 'long' ? price - slPips : price + slPips;
  const be = direction === 'long' ? price + slPips : price - slPips;
  const tp1 = direction === 'long' ? price + slPips * 2 : price - slPips * 2;
  const tp2 = direction === 'long' ? price + slPips * 3 : price - slPips * 3;

  // ── Best pattern ──
  let pattern = 'Trend Follow';
  if (sweepScore >= 35 && chochScore >= 20) pattern = 'Expansion Model ★';
  else if (sweepScore >= 25 && direction === 'short') pattern = 'BSL Sweep Short';
  else if (sweepScore >= 25 && direction === 'long') pattern = 'SSL Sweep Long';
  else if (fvgScore >= 16) pattern = 'FVG + IFVG Entry';

  // 24HR MISSION MODE:
  // Fire at 85%+ during London/NY, or 90%+ at any hour (catch everything)
  const shouldAlert =
    direction !== null &&
    ((total >= 85 && (sess.london || sess.ny)) ||
     (total >= 90));                              // extreme confluence fires anytime

  const result = {
    timestamp: new Date().toISOString(),
    price,
    direction,
    confluence: total,
    pattern,
    scores: { sweep: sweepScore, choch: chochScore, fvg: fvgScore, trend: trendScore, session: sessScore, tfBonus },
    levels: { entry: price, sl, be, tp1, tp2 },
    session: sess,
    sweep: { bsl: sweep4h.bslSwept || sweep1h.bslSwept, ssl: sweep4h.sslSwept || sweep1h.sslSwept },
    choch: { confirmed: choch15m, forming: choch1m },
    shouldAlert,
  };

  console.log(`  Price: ${price} | Dir: ${direction} | Confluence: ${total}% | Alert: ${result.shouldAlert}`);
  return result;
}

module.exports = { runAnalysis };
