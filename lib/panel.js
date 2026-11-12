/**
 * 观察日志面板（iframe 页面）。
 *
 * 主题：优先用父页面（dsh 前端）postMessage 推来的 --dsw-alias-* 主题变量，
 *       其次按 URL ?theme=，再次跟随系统 prefers-color-scheme。
 * 两个视图：观察（turn 级，可实时 SSE）/ 总结（日、周、月，定时生成）。
 */

export function panelHtml(paths) {
  const { pagePath, jsonPath, streamPath, summariesPath, updatePath, deletePath, dismissedPath, undismissPath } = paths;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆</title>
<style>
  /* 主题色：优先取 dsh 注入的 --dsw-alias-*（父页面 postMessage），否则用本地浅/深色兜底 */
  :root{
    --mp-bg-fb:#ffffff; --mp-surface-fb:#f7f8fa; --mp-surface2-fb:#eef0f4;
    --mp-border-fb:#e4e7ed; --mp-border2-fb:#d3d8e0;
    --mp-fg-fb:#1b1f26; --mp-fg2-fb:#5b6472;
    --mp-brand-fb:#4d6bfe; --mp-ok-fb:#1f9d55; --mp-warn-fb:#b8791a; --mp-err-fb:#d93f3f;
  }
  :root[data-theme="dark"]{
    --mp-bg-fb:#0f1115; --mp-surface-fb:#151922; --mp-surface2-fb:#1d2330;
    --mp-border-fb:#232a37; --mp-border2-fb:#2c3444;
    --mp-fg-fb:#e6e8ee; --mp-fg2-fb:#98a2b3;
    --mp-brand-fb:#7c9cff; --mp-ok-fb:#3ddc84; --mp-warn-fb:#f0c674; --mp-err-fb:#ff6b6b;
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --mp-bg-fb:#0f1115; --mp-surface-fb:#151922; --mp-surface2-fb:#1d2330;
      --mp-border-fb:#232a37; --mp-border2-fb:#2c3444;
      --mp-fg-fb:#e6e8ee; --mp-fg2-fb:#98a2b3;
      --mp-brand-fb:#7c9cff; --mp-ok-fb:#3ddc84; --mp-warn-fb:#f0c674; --mp-err-fb:#ff6b6b;
    }
  }
  :root{
    --mp-bg:var(--dsw-alias-bg-base,var(--mp-bg-fb));
    --mp-surface:var(--dsw-alias-bg-layer-1,var(--mp-surface-fb));
    --mp-surface2:var(--dsw-alias-bg-layer-2,var(--mp-surface2-fb));
    --mp-border:var(--dsw-alias-border-l1,var(--mp-border-fb));
    --mp-border2:var(--dsw-alias-border-l2,var(--mp-border2-fb));
    --mp-fg:var(--dsw-alias-label-primary,var(--mp-fg-fb));
    --mp-fg2:var(--dsw-alias-label-secondary,var(--mp-fg2-fb));
    --mp-brand:var(--dsw-alias-brand-primary,var(--mp-brand-fb));
    --mp-ok:var(--dsw-alias-state-success-primary,var(--mp-ok-fb));
    --mp-warn:var(--dsw-alias-state-warn-primary,var(--mp-warn-fb));
    --mp-err:var(--dsw-alias-state-error-primary,var(--mp-err-fb));
    color-scheme:light dark;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;font:13px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
       background:var(--mp-bg);color:var(--mp-fg)}
  header{position:sticky;top:0;display:flex;align-items:center;gap:10px;
         padding:8px 14px;background:var(--mp-surface);border-bottom:1px solid var(--mp-border);z-index:2}
  .tabs{display:flex;gap:2px;align-items:center}
  .tab{background:none;border:0;color:var(--mp-fg2);padding:5px 10px;border-radius:6px;
       font-size:13px;cursor:pointer;line-height:1.2}
  .tab:hover{background:var(--mp-surface2);color:var(--mp-fg)}
  .tab.on{background:var(--mp-surface2);color:var(--mp-fg);font-weight:600}
  .grow{flex:1}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--mp-border2);flex:none}
  .dot.on{background:var(--mp-ok);box-shadow:0 0 6px var(--mp-ok)}
  .dot.off{background:var(--mp-err)}
  button.act{background:var(--mp-surface2);color:var(--mp-fg);border:1px solid var(--mp-border);
             border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
  button.act:hover{border-color:var(--mp-border2)}
  .tag{font-size:11px;padding:1px 6px;border-radius:4px;background:var(--mp-surface2);color:var(--mp-fg2)}
  .tag.turn{color:var(--mp-brand)}
  .tag.warn{color:var(--mp-warn)}
  .tag.ok{color:var(--mp-ok)}
  main{padding:10px 14px 48px;display:flex;flex-direction:column;gap:8px}
  .card{background:var(--mp-surface);border:1px solid var(--mp-border);border-radius:8px;padding:10px 12px}
  .card.new{border-color:var(--mp-ok)}
  .card.ignored{border-style:dashed;border-color:var(--mp-border2);background:transparent;opacity:.85}
  .card.ignored .meta{opacity:.8}
  .row{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
  .time,.sid,.meta{color:var(--mp-fg2);font-size:11px}
  .sid{opacity:.75}
  .u{color:var(--mp-fg);margin-top:8px;line-height:1.55}
  .a{color:var(--mp-fg2);margin-top:4px;white-space:pre-wrap;line-height:1.55}
  .u b,.a b{color:var(--mp-fg2);font-size:11px;font-weight:600;margin-right:6px;opacity:.8}
  .meta{margin-top:6px}
  .acts{display:flex;gap:2px;margin-left:auto}
  .mini{background:none;border:1px solid transparent;color:var(--mp-fg2);font-size:11px;
        padding:2px 6px;border-radius:4px;cursor:pointer;opacity:.5}
  .card:hover .mini{opacity:1}
  .mini:hover{background:var(--mp-surface2);border-color:var(--mp-border);color:var(--mp-fg)}
  .mini.danger:hover{color:var(--mp-err);border-color:var(--mp-err)}
  .mini.primary{color:var(--mp-brand);opacity:1}
  .edit-box{display:flex;flex-direction:column;gap:5px;margin-top:8px}
  .edit-box label{font-size:11px;color:var(--mp-fg2)}
  .edit-box textarea{width:100%;min-height:60px;resize:vertical;background:var(--mp-bg);
    color:var(--mp-fg);border:1px solid var(--mp-border2);border-radius:6px;padding:6px 8px;
    font:12.5px/1.5 inherit}
  .edit-actions{display:flex;gap:6px;margin-top:2px}
  .empty{color:var(--mp-fg2);padding:24px 4px}
  .sum-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
  .sum-period{font-weight:650;font-size:13.5px}
  .mainline{margin-top:8px;line-height:1.6}
  .topic{margin-top:10px;padding-left:10px;border-left:2px solid var(--mp-border2)}
  .topic h4{margin:0 0 4px;font-size:12.5px;font-weight:600;color:var(--mp-fg)}
  .topic .body{color:var(--mp-fg2);white-space:pre-wrap;font-size:12.5px;line-height:1.55}
  .hint{color:var(--mp-fg2);font-size:11.5px;padding:2px 2px 6px}
</style></head>
<body>
<header>
  <div class="tabs" id="tabs">
    <button class="tab on" data-view="obs">观察</button>
    <button class="tab" data-view="daily">日</button>
    <button class="tab" data-view="weekly">周</button>
    <button class="tab" data-view="monthly">月</button>
  </div>
  <span id="scope" class="tag"></span>
  <span id="count" class="tag"></span>
  <span class="grow"></span>
  <span class="dot" id="dot"></span>
  <button class="act" id="reload">刷新</button>
</header>
<main id="list"><div class="empty">连接中…</div></main>
<script>
const PATHS = ${JSON.stringify({ pagePath, jsonPath, streamPath, summariesPath, updatePath, deletePath, dismissedPath, undismissPath })};
const list = document.getElementById('list');
const dot = document.getElementById('dot');
const count = document.getElementById('count');
const scopeEl = document.getElementById('scope');
const seen = new Set();
const params = new URLSearchParams(location.search);
const SESSION = params.get('session') || '';
const SHORT = SESSION ? SESSION.replace(/^session-/i, '').slice(0, 8) : '';
let view = 'obs';
let es = null;

// ── 主题 ──────────────────────────────────────────────
(function initTheme(){
  const t = params.get('theme');
  if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
})();
function applyTokens(tokens){
  if (!tokens || typeof tokens !== 'object') return;
  const root = document.documentElement;
  for (const k of Object.keys(tokens)) {
    if (k.indexOf('--dsw-') === 0 && tokens[k]) root.style.setProperty(k, tokens[k]);
  }
  // 由底色亮度决定 color-scheme，保证原生控件（滚动条等）也对齐
  const bg = tokens['--dsw-alias-bg-base'] || '';
  const m = bg.match(/rgba?\\(([^)]+)\\)/);
  if (m) {
    const p = m[1].split(',').map(Number);
    const lum = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
    root.dataset.theme = lum > 0.5 ? 'light' : 'dark';
  }
}
window.addEventListener('message', (e) => {
  const d = e.data;
  if (d && d.type === 'memory-probe:theme') applyTokens(d.tokens);
});

function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmt(t){ const d = new Date(Number(t)); return isNaN(d) ? '' : d.toLocaleString('zh-CN', {hour12:false}); }

// ── 观察视图 ──────────────────────────────────────────
function obsCard(o, fresh){
  const el = document.createElement('div');
  el.className = 'card' + (fresh ? ' new' : '');
  el.dataset.id = String(o.id ?? '');
  el._obs = o;
  const isFallback = String(o.source || '').indexOf('fallback') >= 0;
  const isEdited = String(o.source || '') === 'user-edit';
  el.innerHTML =
    '<div class="row">' +
      '<span class="tag turn">turn ' + esc(o.turn) + '</span>' +
      '<span class="time">' + esc(fmt(o.time)) + '</span>' +
      '<span class="sid">' + esc(String(o.session_id || '').slice(0, 22)) + '</span>' +
      (isFallback ? '<span class="tag warn">规则回退</span>' : '') +
      (isEdited ? '<span class="tag">已手改</span>' : '') +
      '<span class="acts">' +
        '<button class="mini" data-act="edit">编辑</button>' +
        '<button class="mini" data-act="del" title="删除，下一轮对话时会自动补回">删除</button>' +
        '<button class="mini danger" data-act="ignore" title="删除且永久不再生成">忽略</button>' +
      '</span>' +
    '</div>' +
    '<div class="u"><b>用户</b>' + esc(o.user_action || '（无）') + '</div>' +
    '<div class="a"><b>助手</b>' + esc(o.assistant_action || '（无）') + '</div>' +
    '<div class="meta">' + (o.tools ? '工具：' + esc(o.tools) : '未调用工具') + ' · ' + esc(o.source || '') + '</div>';
  return el;
}

/** 卡片进入内联编辑态。 */
function enterEdit(el){
  const o = el._obs || {};
  el.querySelector('.acts').style.display = 'none';
  const box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML =
    '<label>用户（user_action）</label><textarea data-f="u"></textarea>' +
    '<label>助手（assistant_action）</label><textarea data-f="a"></textarea>' +
    '<div class="edit-actions">' +
      '<button class="mini primary" data-act="save">保存</button>' +
      '<button class="mini" data-act="cancel">取消</button>' +
    '</div>';
  el.append(box);
  box.querySelector('[data-f="u"]').value = o.user_action || '';
  box.querySelector('[data-f="a"]').value = o.assistant_action || '';
  box.querySelector('textarea').focus();
}

async function saveEdit(el, btn){
  const id = Number(el.dataset.id);
  const box = el.querySelector('.edit-box');
  const user_action = box.querySelector('[data-f="u"]').value;
  const assistant_action = box.querySelector('[data-f="a"]').value;
  btn.disabled = true;
  btn.textContent = '保存中…';
  try {
    const r = await fetch(PATHS.updatePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, user_action, assistant_action }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.err || '保存失败');
    // 用新值重建卡片
    const next = Object.assign({}, el._obs, { user_action, assistant_action, source: 'user-edit' });
    el.replaceWith(obsCard(next, false));
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '保存';
    alert('保存失败：' + e.message);
  }
}

async function removeObs(el, mode){
  const id = Number(el.dataset.id);
  if (!id) return;
  const msg = mode === 'ignore'
    ? '忽略这一轮？删除后永久不再为它生成观察。'
    : '删除这条观察？下一轮对话或自动对账时，这一轮会被重新观察并补回。';
  if (!confirm(msg)) return;
  try {
    const r = await fetch(PATHS.deletePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, mode }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.err || '删除失败');
    await refresh();
  } catch (e) {
    alert('删除失败：' + e.message);
  }
}

async function undoIgnore(btn){
  const sid = btn.dataset.sid;
  const turn = btn.dataset.turn === '' ? null : Number(btn.dataset.turn);
  const anchor = btn.dataset.anchor === '' ? null : Number(btn.dataset.anchor);
  btn.disabled = true;
  btn.textContent = '恢复中…';
  try {
    const r = await fetch(PATHS.undismissPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: sid, turn, anchor_seq: anchor }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.err || '取消忽略失败');
    await refresh();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '取消忽略';
    alert('取消忽略失败：' + e.message);
  }
}

list.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const el = btn.closest('.card');
  if (!el) return;
  const act = btn.dataset.act;
  if (act === 'edit') enterEdit(el);
  else if (act === 'cancel') el.replaceWith(obsCard(el._obs, false));
  else if (act === 'save') saveEdit(el, btn);
  else if (act === 'del') removeObs(el, 'delete');
  else if (act === 'ignore') removeObs(el, 'ignore');
  else if (act === 'undismiss') undoIgnore(btn);
});

function ignoredCard(d){
  const el = document.createElement('div');
  el.className = 'card ignored';
  el.innerHTML =
    '<div class="row">' +
      '<span class="tag">第 ' + esc(d.turn == null ? '?' : d.turn) + ' 轮</span>' +
      '<span class="tag warn">已忽略</span>' +
      '<span class="sid">' + esc(String(d.created_at || '').slice(0, 19).replace('T', ' ')) + '</span>' +
      '<span class="acts">' +
        '<button class="mini" data-act="undismiss" data-sid="' + esc(d.session_id) + '" data-turn="' + esc(d.turn) + '" data-anchor="' + esc(d.anchor_seq) + '">取消忽略</button>' +
      '</span>' +
    '</div>' +
    '<div class="meta">这一轮不生成观察，也不占据后续观察的上下文位置。</div>';
  return el;
}

/** 观察 + 被忽略的轮次合并渲染，按轮次降序（第 N 轮在最上）。 */
function render(obs, dis){
  list.textContent = '';
  seen.clear();
  for (const o of obs) seen.add(String(o.id ?? (o.session_id + ':' + o.turn + ':' + o.time)));
  if (!obs.length && !dis.length) {
    list.innerHTML = '<div class="empty">' +
      (SESSION
        ? '本会话还没有观察记录。跑完一轮对话后这里会出现一条。'
        : '未绑定会话：请从 dsh 对话区的「记忆」标签页打开。') +
      '</div>';
    count.textContent = '0 条';
    return;
  }
  const items = [];
  for (const o of obs) items.push({ kind: 'obs', turn: o.turn == null ? -1 : Number(o.turn), data: o });
  for (const d of dis) items.push({ kind: 'ig', turn: d.turn == null ? -1 : Number(d.turn), data: d });
  items.sort((a, b) => b.turn - a.turn);
  for (const it of items) list.append(it.kind === 'obs' ? obsCard(it.data, false) : ignoredCard(it.data));
  count.textContent = obs.length + ' 条' + (dis.length ? ' · 忽略 ' + dis.length : '');
}

async function loadObs(){
  const qs = '?limit=200' + (SESSION ? '&session=' + encodeURIComponent(SESSION) : '');
  const dqs = SESSION ? '?session=' + encodeURIComponent(SESSION) : '';
  const [obsRes, disRes] = await Promise.all([
    fetch(PATHS.jsonPath + qs, {cache:'no-store'}),
    fetch(PATHS.dismissedPath + dqs, {cache:'no-store'}),
  ]);
  const obs = await obsRes.json();
  const dis = await disRes.json();
  render(Array.isArray(obs) ? obs : [], Array.isArray(dis) ? dis : []);
}

let refreshTimer = null;
/** 观察生成/补齐后自动刷新（600ms 内多次事件合并成一次）。 */
function scheduleRefresh(){
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (view === 'obs') refresh();
  }, 600);
}

function connectObs(){
  if (es) { es.close(); es = null; }
  const streamUrl = PATHS.streamPath + (SESSION ? '?session=' + encodeURIComponent(SESSION) : '');
  es = new EventSource(streamUrl);
  es.onopen = () => { dot.className = 'dot on'; };
  es.onerror = () => { dot.className = 'dot off'; };
  es.onmessage = () => scheduleRefresh();
}

// ── 总结视图（日 / 周 / 月） ───────────────────────────
function sumCard(s){
  const el = document.createElement('div');
  el.className = 'card';
  let topics = [];
  try { topics = JSON.parse(s.topics || '[]'); } catch {}
  if (!Array.isArray(topics)) topics = [];
  const label = { daily:'日总结', weekly:'周总结', monthly:'月总结' }[s.kind] || s.kind;
  let html =
    '<div class="sum-head">' +
      '<span class="tag ok">' + esc(label) + '</span>' +
      '<span class="sum-period">' + esc(s.period) + '</span>' +
      (s.stats ? '<span class="meta">' + esc(s.stats) + '</span>' : '') +
      (s.updated_at ? '<span class="grow"></span><span class="meta">' + esc(s.updated_at) + '</span>' : '') +
    '</div>';
  if (s.mainline) html += '<div class="mainline">' + esc(s.mainline) + '</div>';
  for (const t of topics) {
    html += '<div class="topic"><h4>' + esc(t.title || '主题') +
            (t.sids && t.sids.length ? ' <span class="sid">' + esc(t.sids.join(', ')) + '</span>' : '') +
            '</h4><div class="body">' + esc(t.content || '') + '</div></div>';
  }
  el.innerHTML = html;
  return el;
}

async function loadSummaries(kind){
  const r = await fetch(PATHS.summariesPath + '?kind=' + encodeURIComponent(kind) + '&limit=60', {cache:'no-store'});
  const rows = await r.json();
  list.textContent = '';
  seen.clear();
  if (!rows.length) {
    const msg = kind === 'daily'
      ? '还没有日总结。日总结在次日 0 点后自动生成（生成后每 30 分钟扫一次缺漏）。'
      : '还没有' + (kind === 'weekly' ? '周' : '月') + '总结。周期性总结在周期结束后自动生成。';
    list.innerHTML = '<div class="hint">总结跨会话聚合，覆盖当天/当周/当月全部会话的观察。</div><div class="empty">' + msg + '</div>';
    count.textContent = '0 条';
    return;
  }
  list.innerHTML = '<div class="hint">总结跨会话聚合，覆盖全部会话的观察记录。</div>';
  rows.forEach(s => list.append(sumCard(s)));
  count.textContent = rows.length + ' 条';
}

// ── 视图切换 ──────────────────────────────────────────
function setView(next){
  view = next;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.view === next);
  scopeEl.textContent = next === 'obs' ? (SESSION ? '本会话 ' + SHORT : '未绑定会话') : '跨会话聚合';
  if (next !== 'obs' && es) { es.close(); es = null; dot.className = 'dot'; }
}

async function refresh(){
  try {
    if (view === 'obs') { await loadObs(); connectObs(); }
    else await loadSummaries(view);
  } catch (e) {
    list.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>';
  }
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b || b.dataset.view === view) return;
  setView(b.dataset.view);
  refresh();
});
document.getElementById('reload').onclick = refresh;

setView('obs');
refresh();
</script>
</body></html>`;
}
