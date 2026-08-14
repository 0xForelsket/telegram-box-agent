/**
 * Telegram Mini App shell.
 *
 * Read-only by design, matching the existing owner dashboard. The commands this
 * replaces are all "show me a list" commands; nothing here mutates state, so a
 * launch payload that somehow leaked cannot be used to delete a reminder or
 * approve a brokered action. Adding write actions later is a deliberate change
 * of posture, not an incremental feature.
 */

export const MINIAPP_TABS = [
  'overview',
  'schedule',
  'reading',
  'memory',
  'agent',
] as const;

export type MiniAppTab = (typeof MINIAPP_TABS)[number];

export function miniAppHtml(): Response {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><title>Bot Console</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style nonce="${nonce}">
:root{
  --bg:var(--tg-theme-bg-color,#0f1319);
  --surface:var(--tg-theme-secondary-bg-color,#161b22);
  --text:var(--tg-theme-text-color,#e8eef6);
  --muted:var(--tg-theme-hint-color,#8a97a8);
  --link:var(--tg-theme-link-color,#4da3ff);
  --line:color-mix(in srgb,var(--muted) 26%,transparent);
  --danger:#ff6f83;--good:#58d5d0;--warn:#f1b45d;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
body{padding:0 0 env(safe-area-inset-bottom)}
main{padding:14px 14px 28px;max-width:760px;margin:auto}
h1{font-size:19px;margin:2px 0 2px;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:12px;margin-bottom:14px}
nav{position:sticky;top:0;z-index:5;display:flex;gap:6px;overflow-x:auto;padding:10px 14px;background:var(--bg);border-bottom:1px solid var(--line);scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
nav button{flex:0 0 auto;border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:999px;padding:7px 13px;font:600 13px inherit;cursor:pointer}
nav button[aria-selected="true"]{background:var(--link);border-color:var(--link);color:var(--bg)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:10px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 10px;font-weight:700}
.kv{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}
.kv:last-child{border-bottom:0}
.kv span{color:var(--muted)}
.kv strong{font-weight:600;text-align:right;word-break:break-word}
.row{padding:10px 0;border-bottom:1px solid var(--line)}
.row:last-child{border-bottom:0}
.row .t{font-weight:600;word-break:break-word}
.row .m{color:var(--muted);font-size:12.5px;margin-top:2px;word-break:break-word}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:11px 13px}
.stat .l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
.stat .v{font-size:19px;font-weight:700;margin-top:3px;letter-spacing:-.02em;word-break:break-word}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid var(--line);color:var(--muted)}
.pill.ok{color:var(--good);border-color:color-mix(in srgb,var(--good) 45%,transparent)}
.pill.warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
.pill.bad{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,transparent)}
.empty{color:var(--muted);font-size:13.5px;padding:6px 0}
.err{background:color-mix(in srgb,var(--danger) 12%,transparent);border:1px solid color-mix(in srgb,var(--danger) 45%,transparent);color:var(--danger);border-radius:12px;padding:13px;font-size:14px}
.bar{height:5px;background:var(--line);border-radius:999px;overflow:hidden;margin-top:6px}
.bar>i{display:block;height:100%;background:var(--link)}
a{color:var(--link);text-decoration:none;word-break:break-all}
.skel{color:var(--muted);text-align:center;padding:44px 0;font-size:14px}
@media(max-width:380px){.grid{grid-template-columns:1fr}}
</style></head><body>
<nav id="tabs" role="tablist"></nav>
<main><h1 id="title">Bot Console</h1><div class="sub" id="sub">Loading…</div><div id="view"><div class="skel">Connecting…</div></div></main>
<script nonce="${nonce}">
(function(){
"use strict";
var tg = window.Telegram && window.Telegram.WebApp;
if (tg) { tg.ready(); tg.expand(); }

var TABS = ${JSON.stringify(MINIAPP_TABS)};
var LABELS = { overview:"Overview", schedule:"Schedule", reading:"Reading", memory:"Memory", agent:"Agent" };
var view = document.getElementById("view");
var sub = document.getElementById("sub");
var data = null, active = TABS[0];

function esc(v){ return String(v==null?"":v).replace(/[&<>"']/g, function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function n(v){ return new Intl.NumberFormat().format(Number(v)||0); }

function card(title, body){ return '<div class="card"><h2>'+esc(title)+'</h2>'+body+'</div>'; }
function kv(k,v){ return '<div class="kv"><span>'+esc(k)+'</span><strong>'+esc(v)+'</strong></div>'; }
function stat(l,v){ return '<div class="stat"><div class="l">'+esc(l)+'</div><div class="v">'+esc(v)+'</div></div>'; }
function rows(list, render){ return list && list.length ? list.map(render).join("") : '<div class="empty">Nothing here yet.</div>'; }
function row(t,m){ return '<div class="row"><div class="t">'+esc(t)+'</div>'+(m?'<div class="m">'+esc(m)+'</div>':"")+'</div>'; }
function health(s){ var c = s==="ok"?"ok":s==="degraded"?"warn":s==="down"?"bad":""; return '<span class="pill '+c+'">'+esc(s||"unknown")+'</span>'; }

function renderOverview(d){
  var s = d.status, u = d.usage;
  var out = '<div class="grid">'
    + stat("Model", s.currentModel) + stat("Calls today", n(u.day.calls))
    + stat("Tokens today", n(u.day.totalTokens)) + stat("Cache hit", u.cacheHitRate)
    + '</div>';
  out += card("Session", kv("Reply style", s.replyStyle) + kv("Ambient memory", s.ambientMemory?"on":"off")
    + kv("Recent turns", n(s.recentTurnCount)) + kv("Command menu", s.commandMenuStatus));
  out += card("Models", kv("Vision", s.visionModel) + kv("Research", s.researchModel) + kv("Summary", s.summaryModel));
  out += card("Providers", rows(s.modelProviderHealth, function(p){
    return '<div class="kv"><span>'+esc(p.provider)+'</span><strong>'+health(p.status)+'</strong></div>'; }));
  if (s.searchQuotas && s.searchQuotas.length) {
    out += card("Search quota", s.searchQuotas.map(function(q){
      var pct = q.cap ? Math.min(100, (q.used/q.cap)*100) : 0;
      return '<div class="row"><div class="kv"><span>'+esc(q.provider)+'</span><strong>'
        + n(q.used) + " / " + (q.cap ? n(q.cap) : "uncapped") + '</strong></div>'
        + (q.cap ? '<div class="bar"><i style="width:'+pct.toFixed(1)+'%"></i></div>' : "") + '</div>'; }).join(""));
  }
  return out;
}

function renderSchedule(d){
  return card("Reminders", rows(d.reminders, function(r){ return row(r.text, r.when + (r.recurrence?" · "+r.recurrence:"")); }))
    + card("Digests", rows(d.digests, function(r){ return row(r.label, r.when + " · " + r.recurrence); }));
}

function renderReading(d){
  return card("Bookmarks", rows(d.bookmarks, function(b){ return row(b.title, b.url); }))
    + card("Feeds", rows(d.feeds, function(f){ return row(f.title, f.url); }))
    + card("Latest sources", d.sources ? '<div class="m">'+esc(d.sources)+'</div>' : '<div class="empty">No grounded answer yet.</div>');
}

function renderMemory(d){
  return card("Summary", d.summary ? '<div class="m">'+esc(d.summary)+'</div>' : '<div class="empty">No summary yet.</div>')
    + card("People", rows(d.people, function(p){ return row(p.name, p.notes); }))
    + card("Topics", rows(d.topics, function(t){ return row(t.topic, t.status); }));
}

function renderAgent(d){
  if (!d.agent) return card("Agent", '<div class="empty">Owner only.</div>');
  var a = d.agent, out = "";
  out += '<div class="grid">' + stat("Daily starts", a.quota ? a.quota.dailyStartsUsed+" / "+a.quota.dailyStartsLimit : "n/a")
    + stat("Active jobs", a.quota ? a.quota.activeJobs+" / "+a.quota.concurrencyLimit : "n/a") + '</div>';
  out += card("Recent jobs", rows(a.jobs, function(j){ return row(j.id+" · "+j.status, j.route+" · "+j.request); }));
  out += card("Artifacts", rows(a.artifacts, function(x){ return row(x.filename, x.size+" · "+x.retention+" · "+x.id); }));
  out += card("Brokered actions", rows(a.actions, function(x){ return row(x.id+" · "+x.status, x.action); }));
  return out;
}

var RENDER = { overview:renderOverview, schedule:renderSchedule, reading:renderReading, memory:renderMemory, agent:renderAgent };

function paint(){
  if (!data) return;
  view.innerHTML = RENDER[active](data);
  var nav = document.getElementById("tabs");
  nav.innerHTML = TABS.filter(function(t){ return t !== "agent" || data.agent; }).map(function(t){
    return '<button role="tab" data-t="'+t+'" aria-selected="'+(t===active)+'">'+esc(LABELS[t])+'</button>'; }).join("");
  Array.prototype.forEach.call(nav.querySelectorAll("button"), function(b){
    b.onclick = function(){ active = b.getAttribute("data-t"); paint();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.selectionChanged(); }; });
}

function load(){
  // Telegram also puts the launch payload in the URL fragment, which is a
  // usable fallback if the SDK failed to load.
  var initData = tg && tg.initData ? tg.initData : "";
  if (!initData) {
    var m = /(?:^|&)tgWebAppData=([^&]*)/.exec(location.hash.slice(1));
    if (m) initData = decodeURIComponent(m[1]);
  }
  if (!initData) {
    sub.textContent = "Unavailable";
    view.innerHTML = '<div class="err">Open this from the bot\\'s menu button inside Telegram.</div>';
    return;
  }
  fetch("/miniapp/api", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ initData: initData }), cache:"no-store" })
    .then(function(r){ return r.json().then(function(b){ if(!r.ok) throw new Error(b.error||("HTTP "+r.status)); return b; }); })
    .then(function(b){ data = b; sub.textContent = b.chatLabel + " · updated " + new Date(b.generatedAt).toLocaleTimeString(); paint(); })
    .catch(function(e){ sub.textContent = "Error"; view.innerHTML = '<div class="err">'+esc(e.message)+'</div>'; });
}
load();
})();
</script></body></html>`,
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        // telegram.org is allowed because the WebApp SDK is the supported way
        // to obtain `initData` and theme variables; nothing else external is.
        // `connect-src 'self'` keeps the app talking only to this Worker, so a
        // launch payload cannot be exfiltrated by injected markup.
        'Content-Security-Policy':
          `default-src 'none'; style-src 'nonce-${nonce}'; `
          + `script-src 'nonce-${nonce}' https://telegram.org; `
          + `connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
}
