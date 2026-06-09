# XAUUSD SMC Scalp Analyzer v3.1
## £20 → £1,000 Mission | Background Scanner + Telegram Alerts

---

## WHAT THIS DOES
- Scans XAUUSD every **5 minutes** during London + NY sessions (Mon–Fri)
- Fires a **Telegram alert** when confluence hits **85%+**
- Runs 24/7 on Render.com **free tier** (no cost)
- Analyses: BSL/SSL sweeps, CHoCH, FVG/IFVG, EMA bias, session timing

---

## STEP 1 — CREATE YOUR TELEGRAM BOT (2 minutes)

1. Open Telegram on your phone
2. Search **@BotFather** → tap Start
3. Send `/newbot`
4. Choose a name (e.g. `XAUUSD Signal Bot`)
5. Choose a username (e.g. `xauusd_signal_bot`)
6. BotFather gives you a **token** — copy it (looks like `7123456789:AAF...`)
7. Search **@userinfobot** → tap Start → it replies with your **Chat ID** (a number)
8. Save both — you need them below

---

## STEP 2 — DEPLOY TO RENDER.COM (5 minutes)

### 2a. Push to GitHub
```bash
# In this folder:
git init
git add .
git commit -m "XAUUSD SMC Bot v3.1"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/xauusd-bot.git
git push -u origin main
```

### 2b. Create Render Web Service
1. Go to **render.com** → Sign up free (use GitHub login)
2. Click **New +** → **Web Service**
3. Connect your GitHub repo → select `xauusd-bot`
4. Fill in:
   - **Name:** `xauusd-bot`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
5. Click **Advanced** → **Add Environment Variables:**

| Key | Value |
|-----|-------|
| `TELEGRAM_TOKEN` | Your bot token from BotFather |
| `TELEGRAM_CHAT_ID` | Your chat ID from userinfobot |
| `TWELVE_KEY` | `e3c9496f7f9548d58aae0e3310893b1d` |
| `RENDER_URL` | `https://YOUR-APP-NAME.onrender.com` (set after first deploy) |

6. Click **Create Web Service**
7. Wait ~2 minutes for deploy
8. You'll get a URL like `https://xauusd-bot.onrender.com`

---

## STEP 3 — CONNECT YOUR FRONTEND

Update your Netlify site to point at the Render server:
- In `public/index.html` the tool already sends Telegram alerts directly from the browser using saved credentials
- For background scanning (alerts even when browser is closed), the Render server handles this automatically

---

## STEP 4 — UPDATE NETLIFY

Drag the `public/index.html` file into your Netlify site dashboard to replace the existing file.

Or use Netlify CLI:
```bash
npm install -g netlify-cli
netlify deploy --prod --dir=public
```

---

## ENVIRONMENT VARIABLES REFERENCE

| Variable | Description | Required |
|----------|-------------|----------|
| `TELEGRAM_TOKEN` | Bot token from @BotFather | YES |
| `TELEGRAM_CHAT_ID` | Your personal chat ID | YES |
| `TWELVE_KEY` | TwelveData API key | YES (default provided) |
| `RENDER_URL` | Your Render app URL (for self-ping) | Recommended |
| `PORT` | Server port (auto-set by Render) | No |

---

## HOW ALERTS WORK

```
Every 5 minutes (London 08:00–17:00 UTC, NY 13:00–22:00 UTC):
  → Fetch 1M, 15M, 1H, 4H candles from TwelveData
  → Score confluence across 6 factors (max 100%)
  → If score ≥ 85% AND in London or NY session:
      → Send Telegram message with full trade details
      → 30-minute cooldown (won't spam same direction)
  → All scans logged to server console
```

---

## CONFLUENCE SCORING

| Factor | Max Score | Notes |
|--------|-----------|-------|
| BSL/SSL Sweep | 35 | Highest weight — stop hunt = smart money |
| CHoCH (15M) | 20 | Structure shift confirms reversal |
| FVG/IFVG | 20 | Entry precision zone |
| 4H + 1H Trend | 30 | EMA20/50 alignment |
| Session | 20 | London/NY overlap = max |
| TF Alignment | 10 | All TFs agree on direction |
| **TOTAL** | **100** | **Alert fires at 85+** |

---

## STRATEGIES

| Strategy | Win Rate | Key Criteria |
|----------|----------|--------------|
| Expansion Model ★ | ~70% | All 3: Sweep + CHoCH + FVG |
| FVG + IFVG | ~72% | With full confluence |
| BSL Sweep Short | ~68% | 4H BSL swept + CHoCH 15M |
| SSL Sweep Long | ~65% | 4H SSL swept + CHoCH 15M |

---

## PHASE PLAN (£20 → £1,000)

| Phase | Risk/Trade | Target | Trades |
|-------|-----------|--------|--------|
| 1 | £1 | £40 | 10 |
| 2 | £2 | £80 | 10 |
| 3 | £5 | £200 | 10 |
| 4 | £10 | £400 | 10 |
| 5 | £15 | £1,000 | 20 |

**Rules:**
- Never risk more than your phase allows
- 3 losses in a day = stop trading that day
- Move SL to breakeven after TP1 hits
- Only trade London or NY sessions

---

## FOLDER STRUCTURE

```
xauusd-bot/
├── package.json          ← Node dependencies
├── README.md             ← This file
├── src/
│   ├── server.js         ← Express server + cron scheduler
│   ├── analyser.js       ← SMC analysis engine
│   └── telegram.js       ← Telegram alert sender
└── public/
    └── index.html        ← Frontend (also deploy to Netlify)
```

---

## TROUBLESHOOTING

**Bot not sending messages?**
- Check TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in Render env vars
- Make sure you started the bot (send `/start` to it in Telegram)
- Check Render logs for `[Telegram]` lines

**No signals firing?**
- Confluence threshold is 85% — this is intentional (high quality only)
- Check if you're within London/NY session hours
- View `/api/latest` on your Render URL to see current score

**Render going to sleep?**
- Free tier sleeps after 15 min inactivity
- The self-ping cron pings every 14 min to prevent this
- Set RENDER_URL env var for this to work

---

*XAUUSD SMC Analyzer v3.1 — Built for the £20 → £1,000 mission*
