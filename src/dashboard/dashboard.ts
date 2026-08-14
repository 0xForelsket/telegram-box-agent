import { RedisClient } from '../utils/redis';
import { sha256Hex } from '../utils/helpers';

const SESSION_TTL_SECONDS = 15 * 60;
const SESSION_PREFIX = 'dashboard_session:v1:';

export interface DashboardSession {
  sessionKey: string;
  ownerUserId: string;
  expiresAt: number;
}

export class DashboardAccess {
  constructor(private readonly redis: RedisClient, private readonly baseUrl: string) {}

  async createSession(sessionKey: string, ownerUserId: string): Promise<{ url: string; expiresInMinutes: number }> {
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = this.toBase64Url(tokenBytes);
    const hash = await this.hash(token);
    const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
    await this.redis.set(
      `${SESSION_PREFIX}${hash}`,
      JSON.stringify({ sessionKey, ownerUserId, expiresAt } satisfies DashboardSession),
      SESSION_TTL_SECONDS,
    );
    return {
      url: `${this.baseUrl.replace(/\/+$/, '')}/dashboard#${token}`,
      expiresInMinutes: SESSION_TTL_SECONDS / 60,
    };
  }

  async authenticate(request: Request): Promise<DashboardSession | null> {
    const authorization = request.headers.get('Authorization') || '';
    const match = authorization.match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
    if (!match) return null;
    const raw = await this.redis.get(`${SESSION_PREFIX}${await this.hash(match[1])}`);
    if (!raw) return null;
    try {
      const session = JSON.parse(raw) as DashboardSession;
      return session.sessionKey && session.ownerUserId && session.expiresAt > Date.now() ? session : null;
    } catch {
      return null;
    }
  }

  private async hash(value: string): Promise<string> {
    return await sha256Hex(value);
  }

  private toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}

export function dashboardHtml(): Response {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Telegram Box Agent Control Room</title>
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:#05070a;--surface:#0b1016;--panel:#0f151d;--panel-2:#111923;--line:#202a37;--line-soft:#18212c;--text:#f4f7fb;--muted:#8d9aab;--faint:#596575;--blue:#4da3ff;--cyan:#46d7f2;--violet:#ad7cff;--good:#58d5d0;--warn:#f1b45d;--bad:#ff6f83}*{box-sizing:border-box}html{background:var(--bg)}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}main{width:min(1420px,100%);margin:auto;padding:34px 32px 54px}header{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-bottom:23px;border-bottom:1px solid var(--line);margin-bottom:0}h1{font-size:clamp(34px,4vw,54px);line-height:1.02;margin:5px 0 8px;letter-spacing:-.045em;font-weight:760}.eyebrow{color:var(--blue);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.13em}.muted{color:var(--muted)}button{display:inline-flex;align-items:center;gap:9px;border:1px solid #263446;background:#0d141d;color:#dce8f7;border-radius:9px;padding:10px 14px;font:700 13px inherit;cursor:pointer;transition:border-color .18s,background .18s,transform .18s}button:hover{border-color:#3f70a7;background:#111d2b}button:active{transform:translateY(1px)}button:focus-visible{outline:2px solid var(--blue);outline-offset:3px}.metric-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));padding:25px 0 24px}.metric{padding:0 24px;border-right:1px solid var(--line)}.metric:first-child{padding-left:3px}.metric:last-child{border-right:0}.label{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.085em;color:var(--muted)}.value{font-size:25px;font-weight:760;margin-top:5px;letter-spacing:-.035em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.value.compact{font-size:20px}.layout{display:grid;grid-template-columns:minmax(0,1.95fr) minmax(300px,.95fr);gap:14px}.stack{display:grid;gap:14px;align-content:start}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}.panel-pad{padding:22px 24px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px}.section-title{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.055em}.range{padding:5px 9px;border:1px solid #28466a;background:#10233a;border-radius:7px;color:#bcdcff;font-size:11px;font-weight:800}.legend{display:flex;gap:16px;color:var(--muted);font-size:12px}.legend span{display:inline-flex;align-items:center;gap:7px}.legend i{width:18px;height:2px;background:var(--blue);display:inline-block}.legend .tokens i{background:var(--violet)}.chart-shell{height:292px;position:relative}.chart-shell canvas{display:block;width:100%;height:100%}.chart-empty{position:absolute;inset:0;display:none;place-items:center;color:var(--muted);font-size:13px}.status-list{display:grid}.status-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:14px;padding:17px 0;border-bottom:1px solid var(--line)}.status-row:first-child{padding-top:2px}.status-row:last-child{border-bottom:0}.status-label{color:#bac4d1;font-size:12px;text-transform:uppercase;letter-spacing:.04em}.status-value{font-size:18px;font-weight:720;letter-spacing:-.02em}.status-value.good{color:var(--good)}.bar-label{display:flex;justify-content:space-between;gap:14px;margin-bottom:7px}.bar-track{height:6px;background:#202a36;border-radius:99px;overflow:hidden}.bar-fill{height:100%;background:var(--blue);border-radius:inherit}.quota{padding:14px 0;border-bottom:1px solid var(--line-soft)}.quota:last-child{border-bottom:0}.quota small{color:var(--muted)}.cache-number{font-size:34px;font-weight:780;letter-spacing:-.04em;color:#d9eaff}.cache-meta{display:flex;align-items:end;justify-content:space-between;margin:4px 0 13px}.subgrid{display:grid;grid-template-columns:1.08fr .92fr;gap:14px}.table-panel{padding:0 18px 7px}.table-panel .section-title{padding:17px 4px 6px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line-soft);font-size:12px;white-space:nowrap}th{color:var(--muted);font-weight:650}td{color:#e5eaf1}tr:last-child td{border-bottom:0}.table-scroll{overflow-x:auto}.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border:1px solid #244b55;border-radius:99px;color:var(--good);font-size:11px}.pill:before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}.pill.degraded{color:var(--warn);border-color:#604b2c}.pill.down{color:var(--bad);border-color:#62333c}.pill.unknown{color:var(--muted);border-color:var(--line)}.empty{color:var(--muted);padding:16px 8px}.jobs{margin-top:14px}.error{display:none;margin-top:16px;padding:16px 18px;border:1px solid #65333d;background:#1b1015;border-radius:10px;color:#ffb8c3}.skeleton{padding:60px;text-align:center;color:var(--muted)}@media(max-width:1000px){main{padding:28px 20px 45px}.metric-strip{grid-template-columns:repeat(3,1fr);row-gap:22px}.metric:nth-child(3){border-right:0}.metric:nth-child(4){padding-left:3px}.layout{grid-template-columns:1fr}.subgrid{grid-template-columns:1fr 1fr}}@media(max-width:680px){main{padding:22px 16px 38px}header{align-items:flex-start;flex-direction:column}h1{font-size:36px}.metric-strip{grid-template-columns:repeat(2,1fr);gap:0;padding:20px 0 18px}.metric{padding:12px 14px;border-bottom:1px solid var(--line)}.metric:nth-child(odd){padding-left:2px}.metric:nth-child(even){border-right:0}.metric:last-child{grid-column:1/-1;border-bottom:0;padding-left:2px}.value{font-size:22px}.layout,.subgrid{display:grid;grid-template-columns:1fr}.panel-pad{padding:19px 16px}.chart-shell{height:245px}.legend{gap:11px}.table-panel{padding-left:10px;padding-right:10px}.status-row{padding:14px 0}}
</style></head><body><main>
<header><div><div class="eyebrow">Owner dashboard</div><h1>Telegram Box Agent Control Room</h1><div class="muted" id="stamp">Loading live telemetry…</div></div><button id="refresh" type="button">Refresh</button></header>
<section id="dashboard" aria-live="polite"><div class="skeleton">Connecting…</div></section><section class="error" id="error" role="alert"></section>
</main><script nonce="${nonce}">
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);const root=document.getElementById('dashboard'),error=document.getElementById('error');
const n=v=>new Intl.NumberFormat().format(v||0),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let lastData=null,resizeTimer=null;
function metric(label,value){return '<div class="metric"><div class="label">'+esc(label)+'</div><div class="value '+(String(value).length>16?'compact':'')+'" title="'+esc(value)+'">'+esc(value)+'</div></div>'}
function health(items){return (items||[]).map(x=>{const reasons=Object.entries(x.errorCategories||{}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+' '+n(v)).join(', ');return '<tr><td>'+esc(x.provider)+'</td><td><span class="pill '+esc(x.status)+'">'+esc(x.status)+'</span></td><td>'+n(x.successes)+' / '+n(x.calls)+(reasons?'<br><small class="muted">'+esc(reasons)+'</small>':'')+'</td></tr>'}).join('')||'<tr><td colspan="3" class="empty">No observations yet</td></tr>'}
function quota(items){return (items||[]).map(q=>{const cap=Number(q.cap)||0,pct=cap?Math.min(100,(Number(q.used)||0)/cap*100):0;return '<div class="quota"><div class="bar-label"><strong>'+esc(q.provider)+'</strong><span>'+n(q.used)+' / '+(cap?n(cap):'uncapped')+'</span></div><div class="bar-track"><div class="bar-fill" style="width:'+pct.toFixed(1)+'%"></div></div><small>'+pct.toFixed(1)+'% used</small></div>'}).join('')||'<div class="empty">No search quotas configured</div>'}
function render(d){lastData=d;const s=d.status,day=d.usage.day,month=d.usage.month,rate=parseFloat(d.cache.hitRate)||0;document.getElementById('stamp').textContent='Updated '+new Date(d.generatedAt).toLocaleString();root.innerHTML=
'<section class="metric-strip">'+metric('Current model',s.currentModel)+metric('Vision route',s.visionModel)+metric('Calls today',n(day.calls))+metric('Searches this month',n(month.searchCalls))+metric('Tokens today',n(day.totalTokens))+'</section>'+ 
'<section class="layout"><div class="stack"><article class="panel panel-pad"><div class="section-head"><div><div class="section-title">Usage over time</div><div class="legend"><span><i></i>Calls</span><span class="tokens"><i></i>Tokens</span></div></div><span class="range">7D</span></div><div class="chart-shell"><canvas id="usageChart" role="img" aria-label="Seven-day calls and token usage chart"></canvas><div class="chart-empty" id="chartEmpty">No usage recorded in the last seven days</div></div></article>'+ 
'<div class="subgrid"><article class="panel table-panel"><div class="section-title">Usage summary</div><div class="table-scroll"><table><tr><th>Period</th><th>Calls</th><th>Errors</th><th>Tokens</th><th>Avg latency</th></tr><tr><td>Today</td><td>'+n(day.calls)+'</td><td>'+n(day.errors)+'</td><td>'+n(day.totalTokens)+'</td><td>'+n(d.usage.dayAverageLatencyMs)+' ms</td></tr><tr><td>This month</td><td>'+n(month.calls)+'</td><td>'+n(month.errors)+'</td><td>'+n(month.totalTokens)+'</td><td>'+n(d.usage.monthAverageLatencyMs)+' ms</td></tr></table></div></article>'+ 
'<article class="panel table-panel"><div class="section-title">Model providers today</div><div class="table-scroll"><table><tr><th>Provider</th><th>Status</th><th>Success</th></tr>'+health(s.modelProviderHealth)+'</table></div></article></div>'+ 
'<article class="panel table-panel"><div class="section-title">Search providers today</div><div class="table-scroll"><table><tr><th>Provider</th><th>Status</th><th>Success</th></tr>'+health(s.searchProviderHealth)+'</table></div></article></div>'+ 
'<aside class="stack"><article class="panel panel-pad"><div class="section-title">System status</div><div class="status-list"><div class="status-row"><span class="status-label">Cache hit rate</span><strong class="cache-number">'+esc(d.cache.hitRate)+'</strong></div><div class="bar-track"><div class="bar-fill" style="width:'+Math.min(100,rate)+'%"></div></div><div class="status-row"><span class="status-label">Scheduled jobs</span><strong class="status-value">'+n(d.jobs.length)+'</strong></div><div class="status-row"><span class="status-label">Command menu</span><strong class="status-value">'+esc(s.commandMenuStatus)+'</strong></div></div></article>'+ 
'<article class="panel panel-pad"><div class="section-title">Search quota</div>'+quota(s.searchQuotas)+'</article>'+ 
'<article class="panel table-panel"><div class="section-title">Scheduled jobs</div><div class="table-scroll"><table><tr><th>Type</th><th>Next run</th><th>Recurrence</th></tr>'+(d.jobs.length?d.jobs.map(j=>'<tr><td>'+esc(j.type)+'</td><td>'+new Date(j.nextAt).toLocaleString()+'</td><td>'+esc(j.recurrence||'once')+'</td></tr>').join(''):'<tr><td colspan="3" class="empty">Nothing scheduled</td></tr>')+'</table></div></article></aside></section>';requestAnimationFrame(()=>drawChart(d.usage.trend||[]))}
function drawChart(data){const canvas=document.getElementById('usageChart');if(!canvas)return;const empty=document.getElementById('chartEmpty'),active=data.some(x=>x.calls||x.totalTokens);empty.style.display=active?'none':'grid';const box=canvas.getBoundingClientRect(),ratio=Math.min(2,window.devicePixelRatio||1);canvas.width=Math.max(1,Math.round(box.width*ratio));canvas.height=Math.max(1,Math.round(box.height*ratio));const c=canvas.getContext('2d');c.scale(ratio,ratio);const w=box.width,h=box.height,p={l:42,r:54,t:18,b:34},cw=w-p.l-p.r,ch=h-p.t-p.b,maxCalls=Math.max(1,...data.map(x=>x.calls)),maxTokens=Math.max(1,...data.map(x=>x.totalTokens));c.font='11px system-ui';c.textBaseline='middle';for(let i=0;i<=4;i++){const y=p.t+ch*i/4;c.strokeStyle='#1b2531';c.lineWidth=1;c.beginPath();c.moveTo(p.l,y);c.lineTo(w-p.r,y);c.stroke();c.fillStyle='#697789';c.textAlign='right';c.fillText(n(Math.round(maxCalls*(1-i/4))),p.l-9,y);c.textAlign='left';c.fillText(compact(Math.round(maxTokens*(1-i/4))),w-p.r+9,y)}data.forEach((x,i)=>{if(w<480&&i%2===1&&i!==data.length-1)return;const px=p.l+(data.length===1?cw/2:cw*i/(data.length-1));c.fillStyle='#748294';c.textAlign=i===0?'left':i===data.length-1?'right':'center';c.fillText(new Date(x.date+'T00:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'}),px,h-12)});plot(data.map(x=>x.calls),maxCalls,'#4da3ff');plot(data.map(x=>x.totalTokens),maxTokens,'#ad7cff');function plot(values,max,color){if(!values.length)return;c.strokeStyle=color;c.lineWidth=2.3;c.lineJoin='round';c.lineCap='round';c.beginPath();values.forEach((v,i)=>{const x=p.l+(values.length===1?cw/2:cw*i/(values.length-1)),y=p.t+ch-(v/max)*ch;i?c.lineTo(x,y):c.moveTo(x,y)});c.stroke();values.forEach((v,i)=>{const x=p.l+(values.length===1?cw/2:cw*i/(values.length-1)),y=p.t+ch-(v/max)*ch;c.fillStyle=color;c.beginPath();c.arc(x,y,2.8,0,Math.PI*2);c.fill()})}}
function compact(v){return v>=1000000?(v/1000000).toFixed(v>=10000000?0:1)+'M':v>=1000?(v/1000).toFixed(v>=10000?0:1)+'K':String(v)}
async function load(){error.style.display='none';if(!token){document.getElementById('stamp').textContent='Access required';root.innerHTML='';error.textContent='This dashboard link is missing its access token. Run /dashboard again.';error.style.display='block';return}try{const button=document.getElementById('refresh');button.disabled=true;const r=await fetch('/dashboard/api',{headers:{Authorization:'Bearer '+token},cache:'no-store'});if(!r.ok)throw new Error(r.status===401?'This dashboard link expired. Run /dashboard again.':'Dashboard request failed: '+r.status);render(await r.json())}catch(e){error.textContent=e.message;error.style.display='block'}finally{document.getElementById('refresh').disabled=false}}
document.getElementById('refresh').onclick=load;load();
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(lastData)drawChart(lastData.usage.trend||[])},100)});
</script></body></html>`, {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':`default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}
