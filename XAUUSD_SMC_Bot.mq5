//+------------------------------------------------------------------+
//|  XAUUSD SMC Auto Trader v3.2                                     |
//|  Polls signal server every 60s, auto-places trades on 85%+ conf  |
//|  Strategies: BSL Sweep, SSL Sweep, FVG/IFVG, Expansion Model     |
//|                                                                    |
//|  INSTALL:                                                          |
//|  1. Copy this file to: MT5/MQL5/Experts/XAUUSD_SMC_Bot.mq5       |
//|  2. In MT5: Tools → Options → Expert Advisors                     |
//|     ✅ Allow algorithmic trading                                   |
//|     ✅ Allow WebRequest for listed URLs                            |
//|     Add your server URL (e.g. https://xauusd-bot.onrender.com)    |
//|  3. Compile (F7), attach to XAUUSD chart                          |
//|  4. Set your server URL in EA inputs                               |
//+------------------------------------------------------------------+

#property copyright "XAUUSD SMC Bot v3.2"
#property version   "3.20"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\OrderInfo.mqh>

//── INPUT PARAMETERS ──────────────────────────────────────────────
input group "=== SERVER SETTINGS ==="
input string ServerURL        = "https://xauusd-bot.onrender.com"; // Signal server URL
input int    PollIntervalSec  = 60;    // How often to check for signals (seconds)
input double MinConfluence    = 85.0;  // Minimum confluence % to place trade

input group "=== RISK MANAGEMENT ==="
input double RiskPercent      = 5.0;   // % of balance to risk per trade
input double MaxLotSize       = 0.50;  // Hard cap on lot size
input double MinLotSize       = 0.01;  // Minimum lot size
input int    SlipPagePts      = 30;    // Max slippage in points
input int    MagicNumber      = 20250609; // Unique ID for this EA's trades

input group "=== TRADE MANAGEMENT ==="
input bool   AutoBreakeven    = true;  // Move SL to BE after TP1 hit
input bool   AutoTP1Close     = true;  // Close 50% at TP1
input bool   TrailingStop     = false; // Enable trailing stop (experimental)
input int    TrailingPts      = 200;   // Trailing stop distance in points

input group "=== SAFETY LIMITS ==="
input int    MaxTradesPerDay  = 6;     // Hard stop after N trades (3 loss rule + buffer)
input int    MaxLossesPerDay  = 3;     // Stop trading after N losses today
input double MaxDailyLossPct  = 15.0;  // Stop trading if daily loss > X% of balance
input bool   SessionFilterOn  = true;  // Only trade London/NY sessions
input bool   PaperMode        = false; // If true: log signals but don't place trades

//── GLOBALS ───────────────────────────────────────────────────────
CTrade        Trade;
CPositionInfo PosInfo;

datetime      lastPollTime    = 0;
datetime      lastSignalTime  = 0;
string        lastSignalDir   = "";
int           tradesToday     = 0;
int           lossesToday     = 0;
double        startBalanceDay = 0;
datetime      lastDayCheck    = 0;
string        lastApiResponse = "";
bool          haltedToday     = false;

// Dashboard display
string        dashPrefix      = "SMC_";

//+------------------------------------------------------------------+
//| EA INIT                                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   Trade.SetExpertMagicNumber(MagicNumber);
   Trade.SetDeviationInPoints(SlipPagePts);
   Trade.SetTypeFilling(ORDER_FILLING_IOC);

   startBalanceDay = AccountInfoDouble(ACCOUNT_BALANCE);
   lastDayCheck    = TimeCurrent();

   Print("╔══════════════════════════════════════╗");
   Print("║  XAUUSD SMC Auto Trader v3.2 STARTED ║");
   Print("╠══════════════════════════════════════╣");
   Print("║  Server:     ", ServerURL);
   Print("║  Min Conf:   ", MinConfluence, "%");
   Print("║  Risk/Trade: ", RiskPercent, "%");
   Print("║  Paper Mode: ", PaperMode ? "YES (no real trades)" : "NO (LIVE)");
   Print("╚══════════════════════════════════════╝");

   // Validate symbol
   if(Symbol() != "XAUUSD" && Symbol() != "XAUUSDm" && Symbol() != "GOLD")
      Alert("⚠️ EA designed for XAUUSD — current chart: ", Symbol());

   DrawDashboard();
   EventSetTimer(PollIntervalSec);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| EA DEINIT                                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   ObjectsDeleteAll(0, dashPrefix);
   Print("XAUUSD SMC Bot stopped. Trades today: ", tradesToday, " | Losses: ", lossesToday);
}

//+------------------------------------------------------------------+
//| TIMER — polls server every PollIntervalSec                        |
//+------------------------------------------------------------------+
void OnTimer()
{
   ResetDailyCounters();
   ManageOpenTrades();
   PollServer();
   DrawDashboard();
}

//+------------------------------------------------------------------+
//| TICK — manage open trades in real time                            |
//+------------------------------------------------------------------+
void OnTick()
{
   ManageOpenTrades();
}

//+------------------------------------------------------------------+
//| RESET DAILY COUNTERS at midnight                                  |
//+------------------------------------------------------------------+
void ResetDailyCounters()
{
   MqlDateTime now; TimeToStruct(TimeCurrent(), now);
   MqlDateTime last; TimeToStruct(lastDayCheck, last);
   if(now.day != last.day)
   {
      tradesToday     = 0;
      lossesToday     = 0;
      haltedToday     = false;
      startBalanceDay = AccountInfoDouble(ACCOUNT_BALANCE);
      lastDayCheck    = TimeCurrent();
      Print("🔄 New day — counters reset. Starting balance: ", startBalanceDay);
   }
}

//+------------------------------------------------------------------+
//| SESSION CHECK — London 08:00–17:00 UTC, NY 13:00–22:00 UTC       |
//+------------------------------------------------------------------+
bool InTradingSession()
{
   if(!SessionFilterOn) return true;
   MqlDateTime t; TimeToStruct(TimeGMT(), t);
   int mins = t.hour * 60 + t.min;
   bool london = (mins >= 480 && mins < 1020);  // 08:00–17:00
   bool ny     = (mins >= 780 && mins < 1320);  // 13:00–22:00
   return london || ny;
}

//+------------------------------------------------------------------+
//| POLL SERVER — fetch /api/latest, parse JSON, act on signal        |
//+------------------------------------------------------------------+
void PollServer()
{
   if(haltedToday)
   {
      Print("🚫 Trading halted for today (loss/trade limit reached)");
      return;
   }

   string headers = "Content-Type: application/json\r\n";
   char   postData[];
   char   result[];
   string resultHeaders;

   string endpoint = ServerURL + "/api/signal";
   int res = WebRequest("GET", endpoint, headers, 5000, postData, result, resultHeaders);

   if(res == -1)
   {
      int err = GetLastError();
      Print("❌ WebRequest failed (", err, ") — check URL in EA inputs and whitelist in MT5 options");
      return;
   }

   string json = CharArrayToString(result);
   lastApiResponse = json;

   // Parse key fields from JSON
   double confluence = ParseDouble(json, "\"confluence\":");
   string direction  = ParseString(json, "\"direction\":\"", "\"");
   string pattern    = ParseString(json, "\"pattern\":\"", "\"");
   double entryPrice = ParseDouble(json, "\"entry\":");
   double slPrice    = ParseDouble(json, "\"sl\":");
   double tp1Price   = ParseDouble(json, "\"tp1\":");
   double tp2Price   = ParseDouble(json, "\"tp2\":");
   string timestamp  = ParseString(json, "\"timestamp\":\"", "\"");
   bool   shouldAlert = (StringFind(json, "\"shouldAlert\":true") >= 0);

   Print("📡 Server: ", confluence, "% | Dir: ", direction, " | Pattern: ", pattern);

   // Guard checks
   if(!shouldAlert || confluence < MinConfluence)           { Print("⏳ Confluence ", confluence, "% < threshold ", MinConfluence, "%"); return; }
   if(direction == "")                                       { Print("⏳ No direction from server"); return; }
   if(!InTradingSession())                                   { Print("⏳ Outside session hours"); return; }
   if(tradesToday >= MaxTradesPerDay)                        { SetHalt("Max trades/day reached"); return; }
   if(lossesToday >= MaxLossesPerDay)                        { SetHalt("Max losses/day reached"); return; }
   if(DailyLossPct() > MaxDailyLossPct)                     { SetHalt("Max daily loss % reached"); return; }
   if(HasOpenPosition())                                     { Print("⏳ Position already open"); return; }
   if(timestamp == lastSignalTime && direction == lastSignalDir) { Print("⏳ Duplicate signal — skipping"); return; }

   // All checks passed — place trade
   Print("🔥 SIGNAL CONFIRMED: ", confluence, "% | ", StringUpper(direction), " | ", pattern);
   PlaceTrade(direction, confluence, pattern, entryPrice, slPrice, tp1Price, tp2Price);

   lastSignalTime = timestamp;
   lastSignalDir  = direction;
}

//+------------------------------------------------------------------+
//| PLACE TRADE                                                        |
//+------------------------------------------------------------------+
void PlaceTrade(string direction, double confluence, string pattern,
                double serverEntry, double serverSL, double tp1, double tp2)
{
   double ask  = SymbolInfoDouble(Symbol(), SYMBOL_ASK);
   double bid  = SymbolInfoDouble(Symbol(), SYMBOL_BID);
   double price = (direction == "long") ? ask : bid;

   // Use server SL if valid, otherwise calculate from live price
   double sl, tp;
   double slDistance = 0;

   if(serverSL > 0 && MathAbs(serverSL - price) > 5 && MathAbs(serverSL - price) < 100)
   {
      sl = serverSL;
      slDistance = MathAbs(price - sl);
   }
   else
   {
      // Fallback: 15 pip SL
      slDistance = 15.0 * _Point * 10; // 15 pips for gold (1 pip = 10 points)
      sl = (direction == "long") ? price - slDistance : price + slDistance;
   }

   // TP2 from server, or 2:1 RR
   if(tp2 > 0 && MathAbs(tp2 - price) > slDistance)
      tp = tp2;
   else
      tp = (direction == "long") ? price + slDistance * 2 : price - slDistance * 2;

   // Lot size from risk %
   double lots = CalcLotSize(slDistance);

   // Normalise prices
   sl = NormalizeDouble(sl, _Digits);
   tp = NormalizeDouble(tp, _Digits);

   string comment = StringFormat("SMC|%s|%.0f%%|%s", direction, confluence, pattern);

   if(PaperMode)
   {
      Print("📝 PAPER TRADE: ", direction, " | Lots: ", lots, " | Entry: ", price,
            " | SL: ", sl, " | TP: ", tp, " | Comment: ", comment);
      tradesToday++;
      return;
   }

   bool ok = false;
   if(direction == "long")
      ok = Trade.Buy(lots, Symbol(), price, sl, tp, comment);
   else
      ok = Trade.Sell(lots, Symbol(), price, sl, tp, comment);

   if(ok)
   {
      tradesToday++;
      ulong ticket = Trade.ResultOrder();
      Print("✅ TRADE PLACED | Ticket: ", ticket, " | ", direction, " | Lots: ", lots,
            " | Entry: ", price, " | SL: ", sl, " | TP: ", tp);
      SendTelegramConfirm(direction, lots, price, sl, tp, confluence, pattern, ticket);
   }
   else
   {
      int err = Trade.ResultRetcode();
      Print("❌ Trade failed | Error: ", err, " | ", Trade.ResultComment());
   }
}

//+------------------------------------------------------------------+
//| MANAGE OPEN TRADES — breakeven + partial close at TP1             |
//+------------------------------------------------------------------+
void ManageOpenTrades()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!PosInfo.SelectByIndex(i)) continue;
      if(PosInfo.Magic() != MagicNumber) continue;
      if(PosInfo.Symbol() != Symbol()) continue;

      double openPrice  = PosInfo.PriceOpen();
      double currentSL  = PosInfo.StopLoss();
      double currentTP  = PosInfo.TakeProfit();
      double currentBid = SymbolInfoDouble(Symbol(), SYMBOL_BID);
      double currentAsk = SymbolInfoDouble(Symbol(), SYMBOL_ASK);
      ulong  ticket     = PosInfo.Ticket();
      ENUM_POSITION_TYPE posType = PosInfo.PositionType();

      double slDistance = MathAbs(openPrice - currentSL);
      double bePrice    = (posType == POSITION_TYPE_BUY) ? openPrice + 2.0 : openPrice - 2.0; // 2pt above entry = breakeven + spread
      double tp1Level   = (posType == POSITION_TYPE_BUY) ? openPrice + slDistance : openPrice - slDistance;

      // ── PARTIAL CLOSE AT TP1 ──
      if(AutoTP1Close)
      {
         bool tp1Hit = (posType == POSITION_TYPE_BUY && currentBid >= tp1Level) ||
                       (posType == POSITION_TYPE_SELL && currentAsk <= tp1Level);
         if(tp1Hit && PosInfo.Volume() > MinLotSize * 1.5)
         {
            double closeHalf = NormalizeDouble(PosInfo.Volume() / 2.0, 2);
            if(closeHalf >= MinLotSize)
            {
               Trade.PositionClosePartial(ticket, closeHalf);
               Print("💰 TP1 hit — closed 50% (", closeHalf, " lots) on ticket ", ticket);
            }
         }
      }

      // ── MOVE SL TO BREAKEVEN ──
      if(AutoBreakeven && currentSL != bePrice)
      {
         bool beCondition = (posType == POSITION_TYPE_BUY && currentBid >= tp1Level) ||
                            (posType == POSITION_TYPE_SELL && currentAsk <= tp1Level);
         if(beCondition)
         {
            double newSL = NormalizeDouble(bePrice, _Digits);
            if((posType == POSITION_TYPE_BUY && newSL > currentSL) ||
               (posType == POSITION_TYPE_SELL && newSL < currentSL))
            {
               Trade.PositionModify(ticket, newSL, currentTP);
               Print("🔒 SL moved to breakeven (", newSL, ") on ticket ", ticket);
            }
         }
      }

      // ── TRAILING STOP ──
      if(TrailingStop)
      {
         double trailDist = TrailingPts * _Point;
         double newTrailSL = 0;
         if(posType == POSITION_TYPE_BUY)
         {
            newTrailSL = NormalizeDouble(currentBid - trailDist, _Digits);
            if(newTrailSL > currentSL && newTrailSL > openPrice)
               Trade.PositionModify(ticket, newTrailSL, currentTP);
         }
         else
         {
            newTrailSL = NormalizeDouble(currentAsk + trailDist, _Digits);
            if(newTrailSL < currentSL && newTrailSL < openPrice)
               Trade.PositionModify(ticket, newTrailSL, currentTP);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| ON TRADE TRANSACTION — track losses                               |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest     &request,
                        const MqlTradeResult      &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
   {
      if(HistoryDealSelect(trans.deal))
      {
         long magic = HistoryDealGetInteger(trans.deal, DEAL_MAGIC);
         if(magic != MagicNumber) return;
         double profit = HistoryDealGetDouble(trans.deal, DEAL_PROFIT);
         ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
         if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY)
         {
            if(profit < 0)
            {
               lossesToday++;
               Print("📉 Loss recorded. Losses today: ", lossesToday, "/", MaxLossesPerDay);
               if(lossesToday >= MaxLossesPerDay)
                  SetHalt("3 losses reached — halting for the day");
            }
            else
            {
               Print("📈 Win! Profit: ", profit, " | Losses today: ", lossesToday);
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| LOT SIZE CALCULATOR                                               |
//+------------------------------------------------------------------+
double CalcLotSize(double slDistance)
{
   double balance  = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskAmt  = balance * (RiskPercent / 100.0);
   double tickVal  = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(Symbol(), SYMBOL_TRADE_TICK_SIZE);

   if(tickVal <= 0 || tickSize <= 0 || slDistance <= 0) return MinLotSize;

   double slTicks  = slDistance / tickSize;
   double lots     = riskAmt / (slTicks * tickVal);

   double stepLot  = SymbolInfoDouble(Symbol(), SYMBOL_VOLUME_STEP);
   lots = MathFloor(lots / stepLot) * stepLot;
   lots = MathMax(MinLotSize, MathMin(MaxLotSize, lots));

   return NormalizeDouble(lots, 2);
}

//+------------------------------------------------------------------+
//| HELPER — check if we have an open position from this EA           |
//+------------------------------------------------------------------+
bool HasOpenPosition()
{
   for(int i = 0; i < PositionsTotal(); i++)
   {
      if(PosInfo.SelectByIndex(i))
         if(PosInfo.Magic() == MagicNumber && PosInfo.Symbol() == Symbol())
            return true;
   }
   return false;
}

//+------------------------------------------------------------------+
//| HELPER — daily loss %                                             |
//+------------------------------------------------------------------+
double DailyLossPct()
{
   double current = AccountInfoDouble(ACCOUNT_BALANCE);
   if(startBalanceDay <= 0) return 0;
   double lossPct = ((startBalanceDay - current) / startBalanceDay) * 100.0;
   return MathMax(0, lossPct);
}

//+------------------------------------------------------------------+
//| HELPER — halt trading                                             |
//+------------------------------------------------------------------+
void SetHalt(string reason)
{
   haltedToday = true;
   Print("🚫 HALT: ", reason);
   Alert("XAUUSD Bot HALTED: ", reason);
}

//+------------------------------------------------------------------+
//| JSON PARSING HELPERS                                              |
//+------------------------------------------------------------------+
double ParseDouble(string json, string key)
{
   int pos = StringFind(json, key);
   if(pos < 0) return 0;
   pos += StringLen(key);
   // Skip whitespace
   while(pos < StringLen(json) && StringGetCharacter(json, pos) == ' ') pos++;
   // Handle null
   if(StringSubstr(json, pos, 4) == "null") return 0;
   string num = "";
   while(pos < StringLen(json))
   {
      ushort c = StringGetCharacter(json, pos);
      if(c == ',' || c == '}' || c == ']' || c == ' ') break;
      num += ShortToString(c);
      pos++;
   }
   return StringToDouble(num);
}

string ParseString(string json, string startKey, string endKey)
{
   int start = StringFind(json, startKey);
   if(start < 0) return "";
   start += StringLen(startKey);
   int end = StringFind(json, endKey, start);
   if(end < 0) return "";
   return StringSubstr(json, start, end - start);
}

string StringUpper(string s)
{
   string r = s;
   StringToUpper(r);
   return r;
}

//+------------------------------------------------------------------+
//| TELEGRAM CONFIRMATION from MT5 (optional — uses WebRequest)      |
//| Only fires if TELEGRAM_TOKEN is set as a global variable in MT5  |
//+------------------------------------------------------------------+
void SendTelegramConfirm(string dir, double lots, double price,
                         double sl, double tp, double conf,
                         string pattern, ulong ticket)
{
   string token  = GlobalVariableGet_Safe("TG_TOKEN");
   string chatId = GlobalVariableGet_Safe("TG_CHAT");
   if(token == "" || chatId == "") return;

   string msg = StringFormat(
      "✅ *MT5 TRADE PLACED*\n\n%s | %.2f lots\nEntry: %.2f | SL: %.2f | TP: %.2f\nConf: %.0f%% | %s\nTicket: %llu",
      StringUpper(dir), lots, price, sl, tp, conf, pattern, ticket
   );

   // URL encode message
   string encoded = EncodeURL(msg);
   string url = StringFormat("https://api.telegram.org/bot%s/sendMessage?chat_id=%s&text=%s&parse_mode=Markdown",
                              token, chatId, encoded);

   char post[], res[];
   string resHeaders;
   WebRequest("GET", url, "", 5000, post, res, resHeaders);
}

string GlobalVariableGet_Safe(string name)
{
   if(GlobalVariableCheck(name))
      return DoubleToString(GlobalVariableGet(name)); // stored as encoded double
   return "";
}

string EncodeURL(string s)
{
   // Basic encoding for Telegram — replace key chars
   StringReplace(s, " ", "%20");
   StringReplace(s, "\n", "%0A");
   StringReplace(s, "*", "%2A");
   StringReplace(s, "|", "%7C");
   StringReplace(s, ":", "%3A");
   return s;
}

//+------------------------------------------------------------------+
//| DASHBOARD — draws info panel on chart                            |
//+------------------------------------------------------------------+
void DrawDashboard()
{
   string prefix = dashPrefix;
   int x = 10, y = 20, gap = 18;

   DrawLabel(prefix+"title",  "XAUUSD SMC BOT v3.2",               x, y,       clrGold,   12, true);
   DrawLabel(prefix+"mode",   PaperMode?"⚠️ PAPER MODE":"✅ LIVE", x, y+=gap,  PaperMode?clrOrange:clrLime, 10, false);
   DrawLabel(prefix+"conf",   "Min Conf: "+DoubleToString(MinConfluence,0)+"%", x, y+=gap, clrSilver, 10, false);
   DrawLabel(prefix+"risk",   "Risk/Trade: "+DoubleToString(RiskPercent,1)+"%", x, y+=gap, clrSilver, 10, false);
   DrawLabel(prefix+"trades", "Trades today: "+IntegerToString(tradesToday)+"/"+IntegerToString(MaxTradesPerDay), x, y+=gap, clrSilver, 10, false);
   DrawLabel(prefix+"losses", "Losses today: "+IntegerToString(lossesToday)+"/"+IntegerToString(MaxLossesPerDay), x, y+=gap, lossesToday>=MaxLossesPerDay?clrRed:clrSilver, 10, false);
   DrawLabel(prefix+"daily",  "Daily P&L: "+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE)-startBalanceDay,2)+" GBP", x, y+=gap, AccountInfoDouble(ACCOUNT_BALANCE)>=startBalanceDay?clrLime:clrRed, 10, false);
   DrawLabel(prefix+"sess",   InTradingSession()?"🟢 SESSION OPEN":"⚫ AWAITING SESSION", x, y+=gap, InTradingSession()?clrLime:clrGray, 10, false);
   DrawLabel(prefix+"halt",   haltedToday?"🚫 HALTED FOR TODAY":"", x, y+=gap, clrRed, 10, true);
   DrawLabel(prefix+"last",   "Last poll: "+TimeToString(TimeCurrent(), TIME_MINUTES), x, y+=gap, clrGray, 9, false);

   ChartRedraw();
}

void DrawLabel(string name, string text, int x, int y, color clr, int fontSize, bool bold)
{
   if(ObjectFind(0, name) < 0)
      ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_FONTSIZE, fontSize);
   ObjectSetString(0, name,  OBJPROP_FONT, bold ? "Arial Bold" : "Arial");
   ObjectSetString(0, name,  OBJPROP_TEXT, text);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
}
//+------------------------------------------------------------------+
