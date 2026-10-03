/**
 * 手机端页面：一个自包含的 HTML（无 CDN、无外部依赖，纯内网可用）。
 *
 * 页面只做两件事：
 *   1. 订阅 /api/stream（SSE）拿整份状态快照，断线自动退回 2 秒轮询；
 *   2. 把快照渲染成手机上看得清的一张卡片流。
 *
 * 渲染逻辑刻意写得「防脏数据」：任何字段缺失都只是那一段不显示，不会白屏。
 */

const CSS = `
:root{
  --bg:#0b0f14; --card:#151c25; --card2:#1b2430; --line:#243141;
  --fg:#e8eef6; --dim:#8fa3b8; --dim2:#63758a;
  --run:#3ddc84; --idle:#7d8fa3; --warn:#ffb454; --err:#ff6b6b; --done:#4ea1ff;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
body{padding-bottom:calc(24px + env(safe-area-inset-bottom))}

#bar{position:sticky;top:0;z-index:9;display:flex;align-items:center;justify-content:space-between;
  gap:8px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;
  background:rgba(11,15,20,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font-size:15px}
.brand b{font-weight:650;letter-spacing:.3px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--idle);flex:none;transition:background .2s}
.dot.on{background:var(--run);box-shadow:0 0 0 4px rgba(61,220,132,.16)}
.dot.off{background:var(--err)}
.meta{font-size:11.5px;color:var(--dim2);text-align:right;line-height:1.35;font-variant-numeric:tabular-nums}

main{padding:12px 12px 0;display:flex;flex-direction:column;gap:12px}

.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:13px 14px}
.hero{background:linear-gradient(160deg,#172130,#131a23);}
.heroTop{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;
  padding:4px 10px;border-radius:999px;background:var(--card2);color:var(--dim);border:1px solid var(--line)}
.pill.run{background:rgba(61,220,132,.14);color:var(--run);border-color:rgba(61,220,132,.3)}
.pill.idle{background:rgba(125,143,163,.14);color:var(--idle)}
.pill.warn{background:rgba(255,180,84,.14);color:var(--warn);border-color:rgba(255,180,84,.3)}
.pill.err{background:rgba(255,107,107,.14);color:var(--err);border-color:rgba(255,107,107,.3)}
.pill.done{background:rgba(78,161,255,.14);color:var(--done);border-color:rgba(78,161,255,.3)}
.grow{flex:1}
.tnum{font-size:12px;color:var(--dim2);font-variant-numeric:tabular-nums}

.act{margin-top:11px;font-size:16px;font-weight:600;line-height:1.45;word-break:break-word}
.act .tool{color:var(--run)}
.sub{margin-top:7px;font-size:13px;color:var(--dim);line-height:1.5;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}

.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:11px 13px}
.stat .k{font-size:11.5px;color:var(--dim2)}
.stat .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}
.stat .v small{font-size:12px;font-weight:500;color:var(--dim2);margin-left:4px}

h2{display:flex;align-items:center;gap:8px;margin:6px 2px 0;font-size:13px;font-weight:650;
  color:var(--dim);letter-spacing:.4px;text-transform:none}
h2 .cnt{font-size:11px;color:var(--dim2);background:var(--card2);border:1px solid var(--line);
  padding:1px 7px;border-radius:999px;font-weight:600}
h2::after{content:"";flex:1;height:1px;background:var(--line)}

.list{display:flex;flex-direction:column;gap:9px}
.item{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:11px 13px}
.item.st-run{border-left:3px solid var(--run)}
.item.st-pend{border-left:3px solid var(--idle)}
.item.st-done{border-left:3px solid var(--done);opacity:.72}
.item.st-err{border-left:3px solid var(--err)}
.row{display:flex;align-items:flex-start;gap:9px}
.ttl{flex:1;font-size:14px;font-weight:550;word-break:break-word;line-height:1.45}
.desc{margin-top:6px;font-size:12.5px;color:var(--dim);line-height:1.5;word-break:break-word}
.tags{margin-top:8px;display:flex;flex-wrap:wrap;gap:6px}
.tag{font-size:11px;color:var(--dim2);background:var(--card2);border:1px solid var(--line);
  padding:2px 8px;border-radius:7px;font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

.feed{display:flex;flex-direction:column;gap:0}
.ev{display:flex;gap:10px;padding:8px 2px;border-bottom:1px dashed var(--line);font-size:13px}
.ev:last-child{border-bottom:0}
.ev .t{color:var(--dim2);font-size:11.5px;font-variant-numeric:tabular-nums;flex:none;width:52px;padding-top:1px}
.ev .x{flex:1;color:var(--fg);word-break:break-word;line-height:1.45}
.ev .x .who{color:var(--dim2);font-size:11.5px;margin-right:5px}
.ev.k-tool .x{color:#bfe9d2}
.ev.k-user .x{color:#cfe1f5}
.ev.k-err .x{color:var(--err)}
.ev.k-sys .x{color:var(--dim2)}

.empty{color:var(--dim2);font-size:13px;padding:14px 2px;text-align:center}
.note{font-size:12px;color:var(--warn);background:rgba(255,180,84,.08);border:1px solid rgba(255,180,84,.25);
  border-radius:10px;padding:9px 11px;line-height:1.5}
.foot{text-align:center;color:var(--dim2);font-size:11px;padding:4px 0 0;line-height:1.6}
.bar{height:4px;background:var(--card2);border-radius:999px;overflow:hidden;margin-top:9px}
.bar i{display:block;height:100%;background:var(--done);border-radius:999px;transition:width .3s}
`;

const JS = String.raw`
var POLL_MS = 2500, es = null, poll = null, last = null, fails = 0, timer = null;

function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function hhmmss(ms){
  var d = new Date(ms || Date.now());
  function p(n){ return (n<10?'0':'')+n }
  return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
function dur(ms){
  if (!(ms > 0)) return '';
  var s = Math.floor(ms/1000);
  if (s < 60) return s + ' 秒';
  var m = Math.floor(s/60);
  if (m < 60) return m + ' 分 ' + (s%60) + ' 秒';
  var h = Math.floor(m/60);
  return h + ' 时 ' + (m%60) + ' 分';
}
function ago(t){
  if (!t) return '';
  var s = Math.floor((Date.now()-t)/1000);
  if (s < 5) return '刚刚';
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s/60) + ' 分钟前';
  if (s < 86400) return Math.floor(s/3600) + ' 小时前';
  return Math.floor(s/86400) + ' 天前';
}
function shortId(id){ return String(id||'').replace(/^session-/,'').slice(0,6) }

function pill(text, cls){ return '<span class="pill '+cls+'">'+esc(text)+'</span>' }

function section(title, count, inner){
  return '<h2>'+esc(title)+(count==null?'':'<span class="cnt">'+count+'</span>')+'</h2>'+inner;
}

function statCard(k, v, unit){
  return '<div class="stat"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+
         (unit?'<small>'+esc(unit)+'</small>':'')+'</div></div>';
}

function render(s){
  if (!s || !s.ok){ return }
  last = s;
  var out = [];

  /* ── 头牌：现在在干什么 ── */
  var busy = (s.agents||[]).filter(function(a){ return a.running });
  var primary = busy[0] || (s.agents||[])[0] || null;
  var hp = busy.length
    ? pill('运行中', 'run')
    : pill('空闲', 'idle');
  var age = primary && primary.since ? '已运行 ' + dur(Date.now()-primary.since) : '';
  var act = primary && primary.action
    ? '正在执行 <span class="tool">'+esc(primary.action.name)+'</span>'
    : (busy.length ? '模型思考中…' : '当前没有在跑的任务');

  out.push('<div class="card hero">'+
    '<div class="heroTop">'+hp+
      '<span class="grow"></span>'+
      '<span class="tnum">'+esc(age)+'</span>'+
    '</div>'+
    '<div class="act">'+act+'</div>'+
    (primary && primary.action && primary.action.brief
      ? '<div class="sub mono">'+esc(primary.action.brief)+'</div>' : '')+
    (primary && primary.last
      ? '<div class="sub">'+(primary.lastKind==='user'?'你：':'助手：')+esc(primary.last)+'</div>'
      : '')+
    (s.goal ? '<div class="bar"><i style="width:'+goalPct(s.goal)+'%"></i></div>' : '')+
  '</div>');

  /* ── 统计 ── */
  var st = s.stats || {};
  out.push('<div class="grid">'+
    statCard('在跑 / 会话', (st.running||0)+' / '+(st.agents||0))+
    statCard('团队任务', (st.tasksDone||0)+' / '+(st.tasks||0), '完成')+
    statCard('进行中任务', st.tasksActive||0)+
    statCard('后台作业', (st.jobsRunning||0)+' / '+(st.jobs||0))+
  '</div>');

  /* ── 目标 ── */
  if (s.goal){
    out.push(section('当前目标', null,
      '<div class="list"><div class="item">'+
      '<div class="row"><div class="ttl">'+esc(s.goal.objective)+'</div>'+
      pill(goalPhase(s.goal.phase), goalPhaseCls(s.goal.phase))+'</div>'+
      '<div class="tags">'+
        '<span class="tag">第 '+(s.goal.roundsStarted||0)+' / '+(s.goal.maxGoalRounds||'∞')+' 轮</span>'+
        '<span class="tag">'+esc(s.goal.activation==='armed'?'已武装':'已解除')+'</span>'+
        '<span class="tag">'+esc(ago(s.goal.updatedAt))+'</span>'+
      '</div>'+
      (s.goal.blockedReason ? '<div class="desc">卡住原因：'+esc(s.goal.blockedReason.message||s.goal.blockedReason.code)+'</div>' : '')+
      '</div></div>'));
  }

  /* ── 团队任务板 ── */
  if (s.tasks && s.tasks.length){
    var items = s.tasks.map(function(t){
      var cls = t.status==='completed' ? 'st-done' : (t.status==='in_progress' ? 'st-run' : 'st-pend');
      var p = t.status==='completed' ? pill('已完成','done')
            : (t.status==='in_progress' ? pill('进行中','run') : pill('待办','idle'));
      return '<div class="item '+cls+'">'+
        '<div class="row"><div class="ttl">'+esc(t.subject)+'</div>'+p+'</div>'+
        (t.description ? '<div class="desc">'+esc(t.description)+'</div>' : '')+
        '<div class="tags">'+
          '<span class="tag mono">'+esc(t.id)+'</span>'+
          (t.owner ? '<span class="tag">负责人 '+esc(t.owner)+'</span>' : '<span class="tag">未认领</span>')+
          (t.blockedBy && t.blockedBy.length ? '<span class="tag">等 '+esc(t.blockedBy.join(','))+'</span>' : '')+
        '</div></div>';
    }).join('');
    out.push(section('团队任务板', s.tasks.length, '<div class="list">'+items+'</div>'));
  }

  /* ── 团队成员 ── */
  if (s.members && s.members.length){
    var mi = s.members.map(function(m){
      var cls = m.status==='running' ? 'st-run' : (m.status==='failed' ? 'st-err' : 'st-pend');
      var p = m.status==='running' ? pill('运行中','run')
            : (m.status==='failed' ? pill('失败','err')
            : (m.status==='provisioning' ? pill('创建中','warn') : pill('空闲','idle')));
      return '<div class="item '+cls+'"><div class="row"><div class="ttl">'+esc(m.name)+
        (m.role==='lead'?' <span class="tag">Lead</span>':'')+'</div>'+p+'</div>'+
        (m.description ? '<div class="desc">'+esc(m.description)+'</div>' : '')+
        '</div>';
    }).join('');
    out.push(section('团队成员', s.members.length, '<div class="list">'+mi+'</div>'));
  }

  /* ── 会话 ── */
  if (s.agents && s.agents.length){
    var ai = s.agents.map(function(a){
      var p = a.running ? pill('运行中','run') : pill('空闲','idle');
      return '<div class="item '+(a.running?'st-run':'')+'">'+
        '<div class="row"><div class="ttl">'+esc(a.title || ('会话 '+shortId(a.id)))+'</div>'+p+'</div>'+
        (a.action ? '<div class="desc mono">执行中：'+esc(a.action.name)+' '+esc(a.action.brief||'')+'</div>' : '')+
        '<div class="tags">'+
          '<span class="tag mono">'+esc(shortId(a.id))+'</span>'+
          (a.kind==='sub' ? '<span class="tag">子代理 L'+esc(a.depth||0)+'</span>' : '<span class="tag">主会话</span>')+
          (a.turns ? '<span class="tag">'+a.turns+' 轮</span>' : '')+
          (a.errors ? '<span class="tag" style="color:var(--err)">'+a.errors+' 次出错</span>' : '')+
          '<span class="tag">'+esc(ago(a.updatedAt))+'</span>'+
        '</div></div>';
    }).join('');
    out.push(section('会话 / 代理', s.agents.length, '<div class="list">'+ai+'</div>'));
  }

  /* ── 后台作业 ── */
  if (s.jobs && s.jobs.length){
    var ji = s.jobs.map(function(j){
      var cls = j.status==='running'||j.status==='stopping' ? 'st-run' : (j.status==='failed' ? 'st-err' : 'st-done');
      var p = j.status==='running' ? pill('运行中','run')
            : (j.status==='stopping' ? pill('停止中','warn')
            : (j.status==='failed' ? pill('失败','err')
            : (j.status==='killed' ? pill('已终止','warn') : pill('已完成','done'))));
      return '<div class="item '+cls+'"><div class="row"><div class="ttl">'+esc(j.label)+'</div>'+p+'</div>'+
        (j.progress ? '<div class="desc mono">'+esc(j.progress)+'</div>' : '')+
        (j.detail ? '<div class="desc">'+esc(j.detail)+'</div>' : '')+
        '<div class="tags"><span class="tag mono">'+esc(j.id)+'</span>'+
        '<span class="tag">'+esc(j.kind)+'</span>'+
        '<span class="tag">'+esc(j.finishedAt ? dur(j.finishedAt-j.startedAt) : dur(Date.now()-j.startedAt))+'</span>'+
        '</div></div>';
    }).join('');
    out.push(section('后台作业', s.jobs.length, '<div class="list">'+ji+'</div>'));
  }

  /* ── 活动流水 ── */
  if (s.activity && s.activity.length){
    var ev = s.activity.map(function(e){
      return '<div class="ev k-'+esc(e.kind||'sys')+'">'+
        '<div class="t">'+esc(hhmmss(e.t))+'</div>'+
        '<div class="x">'+(e.who?'<span class="who">'+esc(e.who)+'</span>':'')+esc(e.text)+'</div>'+
      '</div>';
    }).join('');
    out.push(section('最新动态', null, '<div class="card feed">'+ev+'</div>'));
  }

  if (s.notes && s.notes.length){
    out.push('<div class="note">'+s.notes.map(esc).join('<br>')+'</div>');
  }

  out.push('<div class="foot">'+esc(s.host||'')+':'+esc(s.port||'')+
    ' · '+esc(s.version||'')+' · 更新于 '+esc(hhmmss(s.now))+'</div>');

  document.getElementById('app').innerHTML = out.join('');

  var d = document.getElementById('dot');
  d.className = 'dot ' + (busy.length ? 'on' : '');
  document.getElementById('link').textContent = '实时连接';
  document.getElementById('clock').textContent = hhmmss(s.now);
}

function goalPct(g){
  if (!g) return 0;
  if (g.phase === 'complete') return 100;
  var max = g.maxGoalRounds || 0;
  if (!max) return 8;
  return Math.max(3, Math.min(100, Math.round((g.roundsStarted||0) / max * 100)));
}
function goalPhase(p){
  return p==='active' ? '进行中' : p==='paused' ? '已暂停' : p==='blocked' ? '受阻' : p==='complete' ? '已完成' : (p||'');
}
function goalPhaseCls(p){
  return p==='active' ? 'run' : p==='blocked' ? 'err' : p==='complete' ? 'done' : 'warn';
}
function fmtK(n){
  if (n >= 1000000) return (n/1000000).toFixed(1)+'M';
  if (n >= 1000) return (n/1000).toFixed(1)+'k';
  return String(n);
}

/* ── 取数据：优先 SSE，连不上就退回轮询 ── */
function qs(){ return location.search || '' }

function startPoll(){
  if (poll) return;
  poll = setInterval(fetchOnce, POLL_MS);
  fetchOnce();
}
function stopPoll(){ if (poll){ clearInterval(poll); poll = null } }

function fetchOnce(){
  fetch('/api/state'+qs(), { cache:'no-store' })
    .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json() })
    .then(function(s){ fails=0; render(s) })
    .catch(function(){ fail() });
}

function fail(){
  fails++;
  var d = document.getElementById('dot');
  d.className = 'dot off';
  document.getElementById('link').textContent = '连接断开·重试中';
  if (fails >= 2 && !poll) startPoll();
}

function startSse(){
  if (typeof EventSource === 'undefined'){ startPoll(); return }
  try { es = new EventSource('/api/stream'+qs()) } catch(e){ startPoll(); return }
  es.onmessage = function(ev){
    fails = 0; stopPoll();
    try { render(JSON.parse(ev.data)) } catch(e){}
  };
  es.onerror = function(){
    fail();
    /* EventSource 自己会重连；这里只在连续失败时补一个轮询兜底 */
  };
}

document.addEventListener('visibilitychange', function(){
  if (!document.hidden){ fetchOnce(); }
});

startSse();
` + '\n';

/**
 * @param {{version:string, port:number, host:string, token:string}} meta
 * @returns {string} 完整 HTML
 */
export function renderPage(meta) {
  const m = meta && typeof meta === 'object' ? meta : {}
  const title = 'DSH 任务看板'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0f14">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${escapeAttr(title)}">
<meta name="robots" content="noindex,nofollow">
<link rel="manifest" href="/manifest.webmanifest${m.token ? `?k=${encodeURIComponent(m.token)}` : ''}">
<link rel="apple-touch-icon" href="/icon.svg">
<title>${escapeAttr(title)}</title>
<style>${CSS}</style>
</head>
<body>
<header id="bar">
  <div class="brand"><span class="dot" id="dot"></span><b>${escapeAttr(title)}</b></div>
  <div class="meta"><span id="clock">--:--:--</span><br><span id="link">连接中…</span></div>
</header>
<main id="app"><div class="empty">正在读取状态…</div></main>
<script>${JS}</script>
</body>
</html>`
}

function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 内联 SVG 图标：一个小显示器 + 信号波纹，避免额外请求与外部资源。 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<rect width="64" height="64" rx="14" fill="#0b0f14"/>
<rect x="14" y="17" width="36" height="24" rx="4" fill="none" stroke="#3ddc84" stroke-width="3"/>
<rect x="26" y="44" width="12" height="3" rx="1.5" fill="#3ddc84"/>
<path d="M22 29h6l3-6 4 12 3-6h6" fill="none" stroke="#4ea1ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
