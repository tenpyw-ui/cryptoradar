"use strict";
/* КриптоРадар — серверный ИИ: аналитика + несколько paper-trading ботов (Railway).
   - Аналитик каждые ANALYSIS_INTERVAL_HOURS изучает поток новостей + рынок.
   - 3 независимых бота (каждый со своим набором монет и стилем) торгуют на $START_BALANCE
     каждые RUN_INTERVAL_HOURS. Сравнение стратегий — на сайте.
   Хранится в DATA_DIR/state.json. */

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const OR_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = process.env.MODEL || "google/gemini-2.5-flash";
const INTERVAL_H = parseFloat(process.env.RUN_INTERVAL_HOURS || "12");
const ANALYSIS_INTERVAL_H = parseFloat(process.env.ANALYSIS_INTERVAL_HOURS || "1");
const START_BALANCE = parseFloat(process.env.START_BALANCE || "1000");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const FEE = 0.001;

/* определения ботов */
const BOTS_DEF = [
  {id: "btceth", label: "BTC + ETH", coins: ["bitcoin", "ethereum"],
   style: "Ты консервативный трейдер: торгуешь только Bitcoin и Ethereum. Цель — рост при низком риске, без резких движений."},
  {id: "alts", label: "5 крупных альтов", coins: ["solana", "binancecoin", "ripple", "cardano", "dogecoin"],
   style: "Ты торгуешь только крупными альткоинами из списка. Ищешь моментум и возможности, но контролируешь риск и не вкладываешь всё в одну монету."},
  {id: "all", label: "Весь топ-100", coins: null,
   style: "Ты можешь торговать любой монетой из топ-100. Ищешь лучшие возможности по всему рынку, диверсифицируешь."}
];

/* ---------- состояние ---------- */
function newBot(def){
  return {label: def.label, coins: def.coins, style: def.style,
          cash: START_BALANCE, holdings: {}, trades: [], reports: [],
          equity: [{t: Date.now(), v: START_BALANCE}], btcStart: null,
          lastRun: 0, lastError: null, lastPrices: {}, btcPrice: null};
}
function newState(){
  const bots = {};
  BOTS_DEF.forEach(d => bots[d.id] = newBot(d));
  return {start: Date.now(), analysis: null, analysisHistory: [], analysisError: null, bots};
}
let state;
try{
  fs.mkdirSync(DATA_DIR, {recursive: true});
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if(!state.bots) state = newState();
  if(!state.analysisHistory) state.analysisHistory = [];
  console.log("Состояние загружено:", STATE_FILE);
}catch(e){
  state = newState();
  console.log("Новое состояние");
}
/* синхронизируем определения ботов (label/coins/style) и добавляем недостающих */
BOTS_DEF.forEach(d => {
  if(!state.bots[d.id]) state.bots[d.id] = newBot(d);
  else { state.bots[d.id].label = d.label; state.bots[d.id].coins = d.coins; state.bots[d.id].style = d.style; }
});
function save(){
  try{ fs.writeFileSync(STATE_FILE, JSON.stringify(state)); }
  catch(e){ console.error("Ошибка сохранения:", e.message); }
}

/* ---------- данные рынка ---------- */
async function getJSON(url, opts){
  const r = await fetch(url, Object.assign({headers: {"User-Agent": "cryptoradar-bot/1.0", "Accept": "application/json"}}, opts || {}));
  if(!r.ok) throw new Error("HTTP " + r.status + " " + url.split("?")[0]);
  return r.json();
}
function calcRSI(prices, period){
  period = period || 14;
  if(!prices || prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for(let i = 1; i <= period; i++){ const d = prices[i] - prices[i-1]; if(d >= 0) gains += d; else losses -= d; }
  let ag = gains/period, al = losses/period;
  for(let i = period + 1; i < prices.length; i++){
    const d = prices[i] - prices[i-1];
    ag = (ag*(period-1) + (d > 0 ? d : 0)) / period;
    al = (al*(period-1) + (d < 0 ? -d : 0)) / period;
  }
  if(al === 0) return 100;
  return 100 - 100/(1 + ag/al);
}
async function fetchMarket(sparkline){
  const data = await getJSON("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=" + (sparkline ? "true" : "false") + "&price_change_percentage=1h%2C24h%2C7d");
  return data.map(c => {
    c.p1h = c.price_change_percentage_1h_in_currency;
    c.p24h = c.price_change_percentage_24h_in_currency;
    c.p7d = c.price_change_percentage_7d_in_currency;
    if(sparkline){
      const sp = (c.sparkline_in_7d && c.sparkline_in_7d.price) || [];
      c.rsi = calcRSI(sp);
    }
    return c;
  });
}
async function fetchFNG(){
  try{
    const r = await getJSON("https://api.alternative.me/fng/?limit=1");
    return r.data && r.data[0] ? `${r.data[0].value} (${r.data[0].value_classification})` : "нет данных";
  }catch(e){ return "нет данных"; }
}
const NEWS_RSS = [
  ["Cointelegraph", "https://cointelegraph.com/rss"],
  ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"],
  ["Decrypt", "https://decrypt.co/feed"],
  ["Bitcoin Magazine", "https://bitcoinmagazine.com/feed"],
  ["CryptoSlate", "https://cryptoslate.com/feed/"],
  ["ForkLog", "https://forklog.com/feed/"]
];
async function fetchNews(){
  let out = [];
  try{
    const r = await getJSON("https://min-api.cryptocompare.com/data/v2/news/?lang=EN");
    out = out.concat((r.Data || []).slice(0, 25).map(n => `[${(n.source_info && n.source_info.name) || n.source}] ${n.title}`));
  }catch(e){}
  const rss = await Promise.allSettled(NEWS_RSS.map(async ([name, url]) => {
    const r = await getJSON("https://api.rss2json.com/v1/api.json?rss_url=" + encodeURIComponent(url));
    return (r.items || []).slice(0, 10).map(i => `[${name}] ${i.title}`);
  }));
  rss.forEach(x => { if(x.status === "fulfilled") out = out.concat(x.value); });
  const seen = new Set(), dedup = [];
  for(const s of out){ const k = s.toLowerCase().replace(/^\[[^\]]*\]\s*/, ""); if(!seen.has(k)){ seen.add(k); dedup.push(s); } }
  return dedup.slice(0, 50);
}

/* ---------- общий вызов модели ---------- */
async function callModel(system, prompt){
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {"Authorization": "Bearer " + OR_KEY, "Content-Type": "application/json", "X-Title": "CryptoRadar"},
    body: JSON.stringify({model: MODEL, temperature: 0.4,
      messages: [{role: "system", content: system}, {role: "user", content: prompt}]})
  });
  const data = await r.json();
  if(!r.ok || data.error) throw new Error((data.error && data.error.message) || ("OpenRouter HTTP " + r.status));
  return data.choices[0].message.content;
}
function parseAI(text){
  let t = String(text).trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if(a === -1 || b === -1) throw new Error("Модель не вернула JSON");
  return JSON.parse(t.slice(a, b + 1));
}
function marketLines(coins, n){
  return coins.slice(0, n).map(c =>
    `${c.id} (${c.symbol.toUpperCase()}): $${c.current_price}; 1ч ${c.p1h != null ? c.p1h.toFixed(2) : "?"}%; 24ч ${c.p24h != null ? c.p24h.toFixed(2) : "?"}%; 7д ${c.p7d != null ? c.p7d.toFixed(2) : "?"}%; RSI ${c.rsi != null ? c.rsi.toFixed(0) : "?"}`
  ).join("\n");
}

/* ---------- АНАЛИТИК (общий) ---------- */
const ANALYST_SYSTEM = `Ты — профессиональный крипто-аналитик. Тебе дают свежий поток новостей со множества источников, данные рынка (топ-монеты, изменения, RSI) и индекс страха/жадности. Изучи ВСЁ и сделай выводы.
ВАЖНО: ты НЕ предсказываешь точные цены и даты. Ты выявляешь, что сейчас происходит, какие риски и какие возможные сценарии с честной оценкой вероятности. Опирайся на конкретные новости и данные.
Ответь СТРОГО валидным JSON без текста вокруг, всё по-русски, по схеме:
{
 "market_outlook":"3-5 предложений: что сейчас происходит на рынке и почему",
 "sentiment":"risk-on|neutral|risk-off",
 "key_risks":["риск 1","риск 2","риск 3"],
 "opportunities":["возможность 1","2"],
 "scenarios":[{"event":"что может произойти","probability":"низкая|средняя|высокая","impact":"как это повлияет на рынок","coins":["bitcoin"]}],
 "coin_notes":[{"coin":"id монеты","sentiment":"bullish|neutral|bearish","note":"вывод с опорой на новость/данные"}],
 "top_news":[{"title":"заголовок важной новости","why":"почему это важно для рынка"}]
}`;

let analyzing = false;
async function runAnalysis(trigger){
  if(analyzing) return {ok: false, msg: "Анализ уже идёт"};
  if(!OR_KEY) return {ok: false, msg: "Не задан OPENROUTER_API_KEY"};
  analyzing = true;
  console.log("Аналитика (" + trigger + ")…");
  try{
    const coins = await fetchMarket(true);
    const [fngStr, news] = await Promise.all([fetchFNG(), fetchNews()]);
    const prompt = `ИНДЕКС СТРАХА И ЖАДНОСТИ: ${fngStr}

РЫНОК (топ-40 монет):
${marketLines(coins, 40)}

ПОТОК НОВОСТЕЙ (${news.length} шт.):
${news.join("\n")}

Изучи всё и дай структурированную аналитику.`;
    const a = parseAI(await callModel(ANALYST_SYSTEM, prompt));
    a.t = Date.now(); a.model = MODEL; a.newsCount = news.length;
    state.analysis = a; state.analysisError = null;
    state.analysisHistory.push({t: a.t, sentiment: a.sentiment, outlook: a.market_outlook});
    if(state.analysisHistory.length > 300) state.analysisHistory = state.analysisHistory.slice(-300);
    save();
    console.log("Аналитика обновлена, новостей: " + news.length);
    return {ok: true, msg: "Аналитика обновлена (новостей: " + news.length + ")"};
  }catch(e){
    state.analysisError = {t: Date.now(), msg: e.message}; save();
    console.error("Ошибка аналитики:", e.message);
    return {ok: false, msg: e.message};
  }finally{ analyzing = false; }
}

/* ---------- ТРЕЙДЕРЫ ---------- */
function botSystem(bot){
  const list = bot.coins ? bot.coins.join(", ") : "любая монета из топ-100";
  return `Ты — криптотрейдер, управляющий учебным (бумажным) портфелем около $${START_BALANCE}. ${bot.style}
РАЗРЕШЁННЫЕ МОНЕТЫ: ${list}. Используй только их id (например "bitcoin").
Правила: комиссия 0.1% за сделку; не делай микросделок меньше $20; максимум 5 действий за сессию; можно ничего не делать (пустой actions), если неясно; держи риск под контролем; объясняй решения по-русски.
Ответь СТРОГО валидным JSON без текста вокруг, по схеме:
{"analysis":"краткий анализ по-русски","actions":[{"type":"buy"|"sell","coin":"id","usd":число,"reason":"почему"}],"outlook":"план до следующей сессии"}`;
}
function price(coins, id){ const c = coins.find(x => x.id === id); return c ? c.current_price : null; }
function botEquity(bot, coins){
  let v = bot.cash;
  for(const id in bot.holdings){ const p = price(coins, id); if(p != null) v += bot.holdings[id].amount * p; }
  return v;
}
function buildPrompt(bot, universe, coins, fngStr, news){
  const eq = botEquity(bot, coins);
  const hold = Object.keys(bot.holdings).map(id => {
    const h = bot.holdings[id], p = price(coins, id);
    return `- ${id}: ${h.amount.toPrecision(6)} шт, ср.вход $${h.avg.toPrecision(6)}, цена $${p}, стоимость $${p != null ? (h.amount*p).toFixed(2) : "?"}`;
  }).join("\n") || "нет";
  const aHint = state.analysis ? `\nОБЩАЯ АНАЛИТИКА РЫНКА: ${state.analysis.market_outlook} (настроение: ${state.analysis.sentiment})` : "";
  const last = bot.reports.slice(-2).map(r => `(${new Date(r.t).toISOString().slice(0,10)}) ${r.outlook || ""}`).join("\n") || "первая сессия";
  return `СОСТОЯНИЕ ПОРТФЕЛЯ
Кэш: $${bot.cash.toFixed(2)} · Всего: $${eq.toFixed(2)} (старт $${START_BALANCE})
Позиции:
${hold}
${aHint}

ИНДЕКС СТРАХА И ЖАДНОСТИ: ${fngStr}

ДОСТУПНЫЙ РЫНОК:
${marketLines(universe, 40)}

СВЕЖИЕ НОВОСТИ:
${news.slice(0, 18).join("\n")}

ПРОШЛЫЕ ПЛАНЫ:
${last}

Прими торговые решения.`;
}
function execute(bot, coins, actions, allowed){
  const done = [];
  (actions || []).slice(0, 6).forEach(act => {
    const id = String(act.coin || "").toLowerCase().trim();
    if(allowed && !allowed.has(id)) return;
    const p = price(coins, id);
    let usd = +act.usd;
    if(!p || !(usd > 0)) return;
    if(act.type === "buy"){
      usd = Math.min(usd, bot.cash);
      if(usd < 1) return;
      const amount = usd * (1 - FEE) / p;
      const h = bot.holdings[id] || {amount: 0, avg: 0};
      h.avg = (h.avg * h.amount + p * amount) / (h.amount + amount);
      h.amount += amount; bot.holdings[id] = h; bot.cash -= usd;
      done.push({t: Date.now(), type: "buy", id, price: p, usd: +usd.toFixed(2), reason: act.reason || ""});
    } else if(act.type === "sell"){
      const h = bot.holdings[id];
      if(!h || h.amount <= 0) return;
      const amount = Math.min(h.amount, usd / p);
      if(amount * p < 0.5) return;
      h.amount -= amount;
      if(h.amount * p < 0.01) delete bot.holdings[id];
      bot.cash += amount * p * (1 - FEE);
      done.push({t: Date.now(), type: "sell", id, price: p, usd: +(amount*p).toFixed(2), reason: act.reason || ""});
    }
  });
  bot.trades = bot.trades.concat(done);
  return done;
}
const runningBots = {};
async function runSession(botId, trigger){
  const bot = state.bots[botId];
  if(!bot) return {ok: false, msg: "Нет такого бота"};
  if(runningBots[botId]) return {ok: false, msg: "Сессия уже идёт"};
  if(!OR_KEY) return {ok: false, msg: "Не задан OPENROUTER_API_KEY"};
  runningBots[botId] = true;
  console.log("Сессия [" + botId + "] (" + trigger + ")…");
  try{
    const coins = await fetchMarket(true);
    const btc = coins.find(c => c.id === "bitcoin");
    if(!bot.btcStart && btc) bot.btcStart = btc.current_price;
    const universe = bot.coins ? coins.filter(c => bot.coins.includes(c.id)) : coins;
    const allowed = bot.coins ? new Set(bot.coins) : null;
    const [fngStr, news] = await Promise.all([fetchFNG(), fetchNews()]);
    const res = parseAI(await callModel(botSystem(bot), buildPrompt(bot, universe, coins, fngStr, news)));
    const done = execute(bot, coins, res.actions, allowed);
    bot.lastRun = Date.now(); bot.lastError = null;
    const eq = +botEquity(bot, coins).toFixed(2);
    bot.equity.push({t: Date.now(), v: eq});
    bot.btcPrice = btc ? btc.current_price : bot.btcPrice;
    bot.lastPrices = {};
    for(const id in bot.holdings) bot.lastPrices[id] = price(coins, id);
    bot.reports.push({t: Date.now(), model: MODEL, analysis: res.analysis || "", outlook: res.outlook || "", actions: done, equity: eq, trigger});
    if(bot.equity.length > 5000) bot.equity = bot.equity.slice(-5000);
    save();
    console.log("[" + botId + "] ок: сделок " + done.length + ", баланс $" + eq);
    return {ok: true, msg: bot.label + ": сделок " + done.length + ", баланс $" + eq};
  }catch(e){
    bot.lastError = {t: Date.now(), msg: e.message}; save();
    console.error("[" + botId + "] ошибка:", e.message);
    return {ok: false, msg: e.message};
  }finally{ runningBots[botId] = false; }
}

/* кривая баланса всех ботов каждые 30 минут */
async function equityTick(){
  try{
    const coins = await fetchMarket(false);
    const btc = coins.find(c => c.id === "bitcoin");
    for(const id in state.bots){
      const bot = state.bots[id];
      if(!bot.btcStart && btc) bot.btcStart = btc.current_price;
      bot.btcPrice = btc ? btc.current_price : bot.btcPrice;
      bot.equity.push({t: Date.now(), v: +botEquity(bot, coins).toFixed(2)});
      if(bot.equity.length > 5000) bot.equity = bot.equity.slice(-5000);
      bot.lastPrices = {};
      for(const h in bot.holdings) bot.lastPrices[h] = price(coins, h);
    }
    save();
  }catch(e){ console.error("equityTick:", e.message); }
}

/* планировщик: один бот за тик (стаггеринг), плюс аналитика */
let tradeBusy = false;
async function tickTrade(){
  if(tradeBusy) return;
  const dueId = BOTS_DEF.map(d => d.id).find(id => {
    const b = state.bots[id];
    return b && !runningBots[id] && Date.now() - (b.lastRun || 0) >= INTERVAL_H * 3600 * 1000;
  });
  if(!dueId) return;
  tradeBusy = true;
  try{ await runSession(dueId, "auto"); } finally{ tradeBusy = false; }
}
setInterval(tickTrade, 60 * 1000);
setInterval(() => {
  if(Date.now() - ((state.analysis && state.analysis.t) || 0) >= ANALYSIS_INTERVAL_H * 3600 * 1000) runAnalysis("auto");
}, 60 * 1000);
setInterval(equityTick, 30 * 60 * 1000);
setTimeout(() => runAnalysis("startup"), 12 * 1000);
setTimeout(tickTrade, 45 * 1000);
setTimeout(equityTick, 5 * 1000);

/* ---------- веб-сервер ---------- */
const app = express();
app.use(express.static(path.join(__dirname, "public")));
function auth(req, res){
  if(ADMIN_TOKEN && req.query.token !== ADMIN_TOKEN && req.headers["x-token"] !== ADMIN_TOKEN){
    res.status(403).json({ok: false, msg: "Неверный токен"}); return false;
  }
  return true;
}
app.get("/api/state", (req, res) => {
  res.json({bots: state.bots, analysis: state.analysis, analysisError: state.analysisError, start: state.start,
    config: {model: MODEL, intervalH: INTERVAL_H, analysisIntervalH: ANALYSIS_INTERVAL_H, startBalance: START_BALANCE,
             hasKey: !!OR_KEY, hasToken: !!ADMIN_TOKEN, analyzing, botOrder: BOTS_DEF.map(d => d.id)}});
});
app.post("/api/run", async (req, res) => {
  if(!auth(req, res)) return;
  const id = req.query.bot;
  if(id) return res.json(await runSession(id, "manual"));
  const out = [];
  for(const d of BOTS_DEF) out.push(await runSession(d.id, "manual"));
  res.json({ok: true, msg: out.map(o => o.msg).join(" · ")});
});
app.post("/api/analyze", async (req, res) => { if(!auth(req, res)) return; res.json(await runAnalysis("manual")); });
app.post("/api/reset", (req, res) => {
  if(!auth(req, res)) return;
  state = newState(); save();
  res.json({ok: true, msg: "Сброшено: 3 бота по $" + START_BALANCE});
});
app.listen(PORT, () => console.log("КриптоРадар: " + BOTS_DEF.length + " бота, трейд " + INTERVAL_H + "ч, аналитика " + ANALYSIS_INTERVAL_H + "ч, порт " + PORT));
