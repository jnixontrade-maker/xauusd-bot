# MT5 Auto-Trading Setup Guide
## XAUUSD SMC Bot v3.2 — Expert Advisor

---

## HOW IT WORKS

```
Render Server (every 1 min)
  → Analyses 1M/15M/1H/4H candles
  → Scores confluence (BSL sweep, CHoCH, FVG, session, EMA)
  → If 85%+ → sets shouldAlert: true on /api/signal

MT5 Expert Advisor (every 60s)
  → Polls https://your-server.onrender.com/api/signal
  → If shouldAlert: true AND all safety checks pass:
      → Calculates lot size from risk %
      → Places BUY or SELL on XAUUSD instantly
      → Manages trade: TP1 partial close, breakeven SL, trailing
      → Sends Telegram confirmation
      → Tracks daily losses — halts at 3
```

---

## STEP 1 — INSTALL THE EA FILE

1. Open MT5
2. Click **File → Open Data Folder**
3. Navigate to: `MQL5 → Experts`
4. Copy `XAUUSD_SMC_Bot.mq5` into that folder
5. Back in MT5: press **F5** or click the Refresh button in Navigator
6. You'll see `XAUUSD_SMC_Bot` appear under **Expert Advisors**

---

## STEP 2 — COMPILE THE EA

1. Double-click `XAUUSD_SMC_Bot` in Navigator → MetaEditor opens
2. Press **F7** to compile
3. Should show: `0 errors, 0 warnings`
4. Close MetaEditor

---

## STEP 3 — ALLOW WEBREQUESTS (CRITICAL)

The EA must be able to call your Render server URL.

1. In MT5: **Tools → Options → Expert Advisors**
2. Tick: ✅ **Allow algorithmic trading**
3. Tick: ✅ **Allow WebRequest for listed URLs**
4. Click **+** and add your server URL exactly:
   ```
   https://xauusd-bot.onrender.com
   ```
   (Replace with your actual Render URL)
5. Click OK

---

## STEP 4 — ATTACH TO CHART

1. Open an **XAUUSD** chart (any timeframe — 1M recommended)
2. Make sure the chart is set to **XAUUSD** not XAUUSDm or GOLD
3. Drag `XAUUSD_SMC_Bot` from Navigator onto the chart
4. The EA settings dialog opens — configure inputs:

### KEY SETTINGS TO SET:

| Setting | Recommended Value | Notes |
|---------|------------------|-------|
| ServerURL | `https://YOUR-APP.onrender.com` | Your Render URL |
| PollIntervalSec | `60` | Checks server every 60 seconds |
| MinConfluence | `85` | Only trade 85%+ signals |
| RiskPercent | `5` | 5% of balance per trade |
| MaxLotSize | `0.10` | Safety cap — adjust to your broker |
| MaxTradesPerDay | `6` | Hard stop after 6 trades |
| MaxLossesPerDay | `3` | Halt after 3 losses (strict rule) |
| **PaperMode** | `true` FIRST | **Run in paper mode to test!** |
| AutoBreakeven | `true` | Moves SL to entry after TP1 |
| AutoTP1Close | `true` | Closes 50% at TP1 |
| SessionFilterOn | `true` | Only trades London/NY |

5. Click **OK**
6. You'll see a smiley face 🙂 on the top right of the chart = EA is running

---

## STEP 5 — PAPER TEST FIRST (IMPORTANT)

1. Set `PaperMode = true`
2. Run for at least 2–3 signals
3. Check the **Experts tab** at the bottom of MT5 for log output:
   ```
   📡 Server: 87% | Dir: short | Pattern: BSL Sweep Short
   🔥 SIGNAL CONFIRMED: 87% | SHORT | BSL Sweep Short
   📝 PAPER TRADE: short | Lots: 0.05 | Entry: 3285.20 | SL: 3300.20 | TP: 3255.20
   ```
4. When satisfied — go to inputs, set `PaperMode = false`

---

## STEP 6 — GO LIVE

1. Set `PaperMode = false`
2. Make sure **Auto Trading** is enabled (the "Auto Trading" button in the MT5 toolbar should be green)
3. The EA will now place real trades when signals fire

---

## DASHBOARD ON CHART

The EA draws a live info panel on your chart showing:
- Mode (LIVE or PAPER)
- Min confluence threshold
- Risk per trade
- Trades today / limit
- Losses today / limit
- Daily P&L
- Session status (open/closed)
- Halted status
- Last server poll time

---

## SAFETY RULES (BUILT IN)

| Rule | What happens |
|------|-------------|
| 3 losses in a day | EA stops placing trades until midnight |
| 6 trades in a day | EA stops regardless of wins/losses |
| Daily loss > 15% | EA halts immediately |
| Already in a trade | Won't open a second position |
| Outside session hours | Won't trade (London/NY only) |
| Duplicate signal | Won't re-enter same signal twice |
| Server unreachable | Logs error, skips — does NOT trade |

---

## TRADE MANAGEMENT (AUTO)

Once a trade is open, the EA manages it for you:

1. **TP1 hit** → closes 50% of position automatically
2. **TP1 hit** → moves SL to breakeven (entry price + 2pts for spread)
3. **TP2 hit** → remaining position closed at full TP
4. **SL hit** → loss recorded, loss counter incremented

---

## PHASE PLAN — RECOMMENDED SETTINGS PER PHASE

| Phase | Balance | RiskPercent | MaxLotSize |
|-------|---------|-------------|-----------|
| 1 | £20–£40 | 5% | 0.02 |
| 2 | £40–£80 | 5% | 0.05 |
| 3 | £80–£200 | 5% | 0.10 |
| 4 | £200–£400 | 5% | 0.20 |
| 5 | £400–£1000 | 5% | 0.50 |

Update the EA inputs as your balance grows.

---

## TROUBLESHOOTING

**EA shows 🙁 (sad face) on chart**
→ Auto trading is disabled. Click the "Auto Trading" button in the toolbar.

**"WebRequest failed" in Experts log**
→ URL not whitelisted. Check Tools → Options → Expert Advisors.
→ Make sure URL matches exactly including https://

**"Outside session hours" every time**
→ Check your MT5 server time (bottom right). It must be close to UTC.
→ Or set `SessionFilterOn = false` temporarily to test.

**Lots too small / too large**
→ Check your broker's minimum lot (some brokers use 0.01, others 0.1)
→ Adjust `MinLotSize` and `MaxLotSize` accordingly.

**EA not appearing in Navigator**
→ Make sure file is in MQL5/Experts/ (not MQL5/Scripts/)
→ Press F5 in Navigator to refresh.

---

## FILES IN THIS FOLDER

```
mt5/
├── XAUUSD_SMC_Bot.mq5     ← Copy to MT5/MQL5/Experts/
└── MT5_SETUP.md           ← This guide
```

---

*XAUUSD SMC Bot v3.2 | £20 → £1,000 Mission | Auto-trading via Render + MT5*
