"use strict";
/* КриптоРадар — серверный ИИ для крипто-аналитики и paper-trading (Railway).
   1) Аналитик: каждые ANALYSIS_INTERVAL_HOURS изучает поток новостей со многих
      источников + рынок + индекс страха/жадности и выдаёт структурированные выводы.
   2) Трейдер: каждые RUN_INTERVAL_HOURS торгует на фейковом балансе.
   Всё хранится в DATA_DIR/state.json. */

const express = require("express");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const OR_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = process.env.MODEL || "google/gemini-2.5-flash";
const INTERVAL_H = parseFloat(process.env.RUN_INTERVAL_HOURS || "4");
const ANALYSIS_INTERVAL_H = parseFloat(process.env.ANALYSIS_INTERVAL_HOURS || "6");
const START_BALANCE = parseFloat(process.env.START_BALANCE || "100");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const FEE = 0.001;

/* ---------- состояние ---------- */
function newState(){
  return {start: Date.now(), cash: START_BALANCE, holdings: {}, trades: [],
          reports: [], equity: [{t: Date.now(), v: START_BALANCE}],
          btcStart: null, lastRun: 0, lastError: null,
          analysis: null, analysisHistory: [], analysisError: null};
}
let state;
try{
  fs.mkdirSync(DATA_DIR, {recursive: true});
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if(!state.analysisHistory) state.analysisHistory = [];
  console.log("Состояние загружено:", STATE_FILE);
}catch(e){
  state = newState();
  console.log("Новое состояние, старт $" + START_BALANCE);
}
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
  for(let i = 1; i <= period; i++){
    const d = prices[i] - prices[i-1];
    if(d >= 0) gains += d; else losses -= d;
  }
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
      const sma = sp.length ? sp.reduce((a,b)=>a+b,0)/sp.length : null;
      let score = 0;
      if(c.rsi != null){ if(c.rsi < 30) score += 2; else if(c.rsi < 40) score += 1; else if(c.rsi > 70) score -= 2; else if(c.rsi > 60) score -= 1; }
      if(sma != null){ if(c.current_price > sma*1.02) score += 1; else if(c.current_price < sma*0.98) score -= 1; }
      if(c.p7d != null){ if(c.p7d > 5) score += 1; else if(c.p7d < -5) score -= 1; }
      c.score = score;
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
/* Сбор максимума новостей со многих источников */
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

/* ---------- АНАЛИТИК ---------- */
const ANALYST_SYSTEM = `Ты — профессиональный крипто-аналитик. Тебе дают свежий поток новостей со множества источников, данные рынка (топ-монеты, изменения, RSI) и индекс страха/жадности. Изучи ВСЁ и сделай выводы.
ВАЖНО: ты НЕ предсказываешь точные цены и даты. Ты выявляешь, что сейчас происходит, какие риски и какие возможные сценарии с честной оценкой вероятности. Опирайся на конкретные новости и данные.
Ответь СТРОГО валидным JSON без текста вокруг, всё по-русски, по схеме:
{
 "market_outlook":"3-5 предложений: что сейчас происходит на рынке и почему",
 "sentiment":"risk-on|neutral|risk-off",
 "key_risks":["конкретный риск 1","риск 2","риск 3"],
 "opportunities":["где сейчас потенциал 1","2"],
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

ПОТОК НОВОСТЕЙ (${news.length} шт. со многих источников):
${news.join("\n")}

Изучи всё это и дай структурированную аналитику.`;
    const raw = await callModel(ANALYST_SYSTEM, prompt);
    const a = parseAI(raw);
    a.t = Date.now(); a.model = MODEL; a.newsCount = news.length; a.trigger = trigger;
    state.analysis = a;
    state.analysisError = null;
    state.analysisHistory.push({t: a.t, sentiment: a.sentiment, outlook: a.market_outlook});
    if(state.analysisHistory.length > 300) state.analysisHistory = state.analysisHistory.slice(-300);
    save();
    console.log("Аналитика обновлена, новостей: " + news.length);
    return {ok: true, msg: "Аналитика обновлена (новостей: " + news.length + ")"};
  }catch(e){
    state.analysisError = {t: Date.now(), msg: e.message};
    save();
    console.error("Ошибка аналитики:", e.message);
    return {ok: false, msg: e.message};
  }finally{
    analyzing = false;
  }
}

/* ---------- ТРЕЙДЕР ---------- */
const AI_SYSTEM = `Ты — осторожный криптотрейдер, управляющий учебным (бумажным) портфелем размером около $${START_BALANCE}. Цель — увеличить баланс за месяц при разумном риске.
Правила:
- Можно торговать только монетами из списка (используй их id, например "bitcoin").
- Комиссия 0.1% за сделку. Не делай бессмысленных микросделок меньше $2.
- Максимум 5 действий за сессию. Можно не делать ничего (пустой список actions), если рынок неясен.
- Не вкладывай всё в одну монету, держи риск под контролем.
- Учитывай новости и индекс страха/жадности, объясняй решения по-русски.
Ответь СТРОГО валидным JSON без какого-либо текста вокруг, по схеме:
{"analysis":"краткий анализ рынка по-русски","actions":[{"type":"buy"|"sell","coin":"id монеты","usd":число,"reason":"почему"}],"outlook":"план до следующей сессии"}`;

function price(coins, id){ const c = coins.find(x => x.id === id); return c ? c.current_price : null; }
function equity(coins){
  let v = state.cash;
  for(const id in state.holdings){ const p = price(coins, id); if(p != null) v += state.holdings[id].amount * p; }
  return v;
}
function buildPrompt(coins, fngStr, news){
  const eq = equity(coins);
  const hold = Object.keys(state.holdings).map(id => {
    const h = state.holdings[id], p = price(coins, id);
    return `- ${id}: ${h.amount.toPrecision(6)} шт, ср. вход $${h.avg.toPrecision(6)}, тек. цена $${p}, стоимость $${p != null ? (h.amount*p).toFixed(2) : "?"}`;
  }).join("\n") || "нет";
  const aHint = state.analysis ? `\nСВЕЖАЯ АНАЛИТИКА: ${state.analysis.market_outlook} (настроение: ${state.analysis.sentiment})` : "";
  const lastReports = state.reports.slice(-2).map(r => `(${new Date(r.t).toISOString().slice(0,10)}) ${r.outlook || ""}`).join("\n") || "это первая сессия";
  return `ТЕКУЩЕЕ СОСТОЯНИЕ ПОРТФЕЛЯ
Свободный кэш: $${state.cash.toFixed(2)}
Общая стоимость: $${eq.toFixed(2)} (старт $${START_BALANCE}, день теста ${Math.floor((Date.now()-state.start)/864e5)+1})
Позиции:
${hold}
${aHint}

ИНДЕКС СТРАХА И ЖАДНОСТИ: ${fngStr}

РЫНОК (топ-30 монет):
${marketLines(coins, 30)}

СВЕЖИЕ НОВОСТИ:
${news.slice(0, 20).join("\n")}

ТВОИ ПРОШЛЫЕ ПЛАНЫ:
${lastReports}

Прими торговые решения сейчас.`;
}
function execute(coins, actions){
  const done = [];
  (actions || []).slice(0, 6).forEach(act => {
    const id = String(act.coin || "").toLowerCase().trim();
    const p = price(coins, id);
    let usd = +act.usd;
    if(!p || !(usd > 0)) return;
    if(act.type === "buy"){
      usd = Math.min(usd, state.cash);
      if(usd < 1) return;
      const amount = usd * (1 - FEE) / p;
      const h = state.holdings[id] || {amount: 0, avg: 0};
      h.avg = (h.avg * h.amount + p * amount) / (h.amount + amount);
      h.amount += amount;
      state.holdings[id] = h;
      state.cash -= usd;
      done.push({t: Date.now(), type: "buy", id, price: p, usd: +usd.toFixed(2), reason: act.reason || ""});
    } else if(act.type === "sell"){
      const h = state.holdings[id];
      if(!h || h.amount <= 0) return;
      const amount = Math.min(h.amount, usd / p);
      if(amount * p < 0.5) return;
      h.amount -= amount;
      if(h.amount * p < 0.01) delete state.holdings[id];
      state.cash += amount * p * (1 - FEE);
      done.push({t: Date.now(), type: "sell", id, price: p, usd: +(amount*p).toFixed(2), reason: act.reason || ""});
    }
  });
  state.trades = state.trades.concat(done);
  return done;
}
let running = false;
async function runSession(trigger){
  if(running) return {ok: false, msg: "Сессия уже идёт"};
  if(!OR_KEY) return {ok: false, msg: "Не задан OPENROUTER_API_KEY"};
  running = true;
  console.log("Сессия трейдера (" + trigger + ")…");
  try{
    const coins = await fetchMarket(true);
    if(!state.btcStart){ const b = coins.find(c => c.id === "bitcoin"); if(b) state.btcStart = b.current_price; }
    const [fngStr, news] = await Promise.all([fetchFNG(), fetchNews()]);
    const raw = await callModel(AI_SYSTEM, buildPrompt(coins, fngStr, news));
    const res = parseAI(raw);
    const done = execute(coins, res.actions);
    state.lastRun = Date.now();
    state.lastError = null;
    const eq = +equity(coins).toFixed(2);
    state.equity.push({t: Date.now(), v: eq});
    state.reports.push({t: Date.now(), model: MODEL, analysis: res.analysis || "", outlook: res.outlook || "", actions: done, equity: eq, trigger});
    if(state.equity.length > 5000) state.equity = state.equity.slice(-5000);
    save();
    console.log("Сессия ок: сделок " + done.length + ", баланс $" + eq);
    return {ok: true, msg: "Сделок: " + done.length + ", баланс $" + eq};
  }catch(e){
    state.lastError = {t: Date.now(), msg: e.message};
    save();
    console.error("Ошибка сессии:", e.message);
    return {ok: false, msg: e.message};
  }finally{
    running = false;
  }
}

/* запись кривой баланса каждые 30 минут */
async function equityTick(){
  try{
    const coins = await fetchMarket(false);
    if(!state.btcStart){ const b = coins.find(c => c.id === "bitcoin"); if(b) state.btcStart = b.current_price; }
    state.btcPrice = (coins.find(c => c.id === "bitcoin") || {}).current_price || state.btcPrice;
    state.equity.push({t: Date.now(), v: +equity(coins).toFixed(2)});
    if(state.equity.length > 5000) state.equity = state.equity.slice(-5000);
    state.lastPrices = {};
    for(const id in state.holdings) state.lastPrices[id] = price(coins, id);
    save();
  }catch(e){ console.error("equityTick:", e.message); }
}

/* планировщик */
setInterval(() => {
  if(Date.now() - (state.lastRun || 0) >= INTERVAL_H * 3600 * 1000) runSession("auto");
  if(Date.now() - ((state.analysis && state.analysis.t) || 0) >= ANALYSIS_INTERVAL_H * 3600 * 1000) runAnalysis("auto");
}, 60 * 1000);
setInterval(equityTick, 30 * 60 * 1000);
setTimeout(() => runAnalysis("startup"), 12 * 1000);
setTimeout(() => runSession("startup"), 40 * 1000);
setTimeout(equityTick, 5 * 1000);

/* ---------- веб-сервер ---------- */
const app = express();
app.use(express.static(path.join(__dirname, "public")));
function auth(req, res){
  if(ADMIN_TOKEN && req.query.token !== ADMIN_TOKEN && req.headers["x-token"] !== ADMIN_TOKEN){
    res.status(403).json({ok: false, msg: "Неверный токен"});
    return false;
  }
  return true;
}
app.get("/api/state", (req, res) => {
  res.json({bot: state, config: {model: MODEL, intervalH: INTERVAL_H, analysisIntervalH: ANALYSIS_INTERVAL_H, startBalance: START_BALANCE, hasKey: !!OR_KEY, hasToken: !!ADMIN_TOKEN, running, analyzing}});
});
app.post("/api/run", async (req, res) => { if(!auth(req, res)) return; res.json(await runSession("manual")); });
app.post("/api/analyze", async (req, res) => { if(!auth(req, res)) return; res.json(await runAnalysis("manual")); });
app.post("/api/reset", (req, res) => {
  if(!auth(req, res)) return;
  state = newState();
  save();
  res.json({ok: true, msg: "Тест сброшен, баланс $" + START_BALANCE});
});
app.listen(PORT, () => console.log("КриптоРадар на порту " + PORT + ", модель " + MODEL + ", трейдер " + INTERVAL_H + "ч, аналитика " + ANALYSIS_INTERVAL_H + "ч"));
