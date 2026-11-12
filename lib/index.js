/**
 * dsh-memory-probe — 「观察生成 + 记忆唤醒」的最小链路，带一个 HTTP/SSE 观察面板。
 *
 * 挂载点：
 *   ctx.on('session/event', …)       每条落盘事件（turn/start、turn/end、tool/call …）
 *   ctx.tools.register(defineTool(…)) 注册 memory_wake_probe 工具
 *   ctx.inject(['webServer'])        仅在 web profile 存在：注册 /memory-probe/* 路由
 *
 * 行为：
 *   1) turn/end 时用规则拼一条「模拟观察」（不调模型）
 *   2) 观察写 sqlite（~/.dsh/memory-probe/memory.db）+ JSONL
 *   3) HTTP：GET /memory-probe/（面板页）、/memory-probe/observations.json、/memory-probe/stream（SSE）
 *
 * 不做：不调模型、不改系统提示词、不写会话本身。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describeConfig, loadConfig } from './config.js';

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const DIR = join(HOME, '.dsh', 'memory-probe');
// 包根目录
const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));

const CONFIG = loadConfig({ dirs: [PKG_DIR, DIR] });

// @node-rs/jieba 是 CJS 包（module.exports.xxx = … 形式）：ESM 静态导入拿不到具名导出，
// 必须走 createRequire，否则 cutForSearch 是 undefined（症状：所有 segmented_text 写成空串）
const nodeRequire = createRequire(import.meta.url);
const JIEBA_CANDIDATES = ['@node-rs/jieba', ...(CONFIG.jieba.modulePaths ?? [])];
let cutForSearch = null;
for (const c of JIEBA_CANDIDATES) {
  try {
    const mod = nodeRequire(c);
    if (typeof mod?.cutForSearch === 'function') {
      cutForSearch = mod.cutForSearch;
      break;
    }
  } catch {
    /* 换下一个候选 */
  }
}
if (typeof cutForSearch !== 'function') {
  log('jieba unavailable — FTS 关键词路退化为按空白切分');
  cutForSearch = (text) => String(text ?? '').split(/\s+/).filter(Boolean);
}
import { panelHtml } from './panel.js';

export const name = 'memory-probe';
export const inject = ['tools'];

// 会话事件缓存：dsh 插件只能收到实时事件，删除观察后要能重放，就必须自带事件源
const CACHE_DIR = join(DIR, 'sessions');
const DB_PATH = join(DIR, 'memory.db');
const JSONL_PATH = join(DIR, 'observations.jsonl');
const LOG_PATH = join(DIR, 'probe.log');

log(`config ${describeConfig(CONFIG)}`);
for (const err of CONFIG.sources.errors) log(`config error: ${err}`);
log(
  CONFIG.llm.enabled
    ? 'llm enabled'
    : 'llm not configured — 观察退化为规则摘要'
);

// ── 观察生成用的模型端点 ──────────────────────────────────────────────
const LLM = CONFIG.llm;

/** 取 API key：环境变量优先，其次 secrets 文件。 */
function loadKey() {
  const direct = process.env[LLM.keyEnv];
  if (direct && direct.trim()) return direct.trim();
  if (!LLM.secretsFile) return '';
  try {
    const text = readFileSync(LLM.secretsFile, 'latin1');
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      if (s.slice(0, eq).trim() !== LLM.keyEnv) continue;
      return s.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch (err) {
    log(`loadKey failed: ${err?.message ?? err}`);
  }
  return '';
}

// ── 字符限制（与 pi observe_sync 同参数：四档上限 + 总预算 + 首尾保留裁切） ──
const LIM_USER = 2000;      // 用户输入上限
const LIM_AST = 8000;       // 助手正文上限（保险丝；常规轮 1-2k 不触发）
const LIM_ARGS = 300;       // 工具调用参数上限
const LIM_RESULT = 800;     // 工具返回上限
const BUDGET_CHARS = 60000; // 单窗口总预算 ≈30k tok；超预算动态压工具字符
const FLOOR_ARGS = 40;      // 工具参数裁剪下限
const FLOOR_RESULT = 80;    // 工具返回裁剪下限
const RECENT_OBS = 20;      // 近期观察注入条数（给观察员做背景）
const RECENT_OBS_CHARS = 8000; // 背景总字符预算（观察变长后的护栏，优先保留最近的）

/** 裁切：首尾各留一半 + 显式省略标记（LLM 能看见「这里省略了」，不会把断口当成内容结束）。 */
function clip(text, limit) {
  const s = String(text ?? '');
  if (!s) return '';
  if (s.length <= limit) return s;
  const h = Math.floor(limit / 2);
  return s.slice(0, h) + `\n…[中间省略${s.length - limit}字符]…\n` + s.slice(-h);
}

/** 取一条 content blocks 里的纯文本。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

const LLM_SYSTEM = [
  '你是会话记忆观察员。输入是一段对话窗口，每行一条 JSON（JSONL）：',
  '- {"role":"user","content":"…"}：用户输入（可能连续多条）',
  '- {"role":"assistant","content":[{"type":"text","text":"…"}]}：助手回复；带 note 表示被打断',
  '- {"role":"toolCall","name":"…","arguments":"…"}：助手的工具调用',
  '- {"role":"toolResult","toolName":"…","content":"…"}：工具返回；带 note 表示工具失败',
  '',
  '窗口是自上次观察以来的全部增量，可能包含用户连续多条消息、一次工作被打断后接续。',
  '请把整个窗口当作一段工作来概括，不要只概括最后一条。',
  '',
  '输出严格 JSON，只有两个字段：',
  '{"user_action":"…","assistant_action":"…"}',
  'user_action：第三人称概括用户这段想达成什么 / 在质疑什么。',
  'assistant_action：第三人称概括助手做了什么、得到什么结果、还有什么没做完。',
  '长度按输入末尾「本轮规模」给出的建议来写：步数少的轮次简短，步数多的轮次应当写长一些，',
  '把每一步的关键动作、中间结论、失败的尝试都写进去，不要为了简短丢掉信息。',
  '但建议的字数只是参考上限，不是目标：信息量不足时宁可写得短，禁止凑字数。',
  '',
  '重要：文中形如「…[中间省略N字符]…」表示该处因过长被省略，**不代表内容到此结束**，不要据此判断内容残缺或表格不完整。',
  '要求：概括而不是复述，禁止原样引用对话；只写素材里有的事实；',
  '若这段信息量很低（寒暄、单句确认、纯测试），写「低信息量轮次」并说明实际发生了什么。',
].join('\n');

function parseJsonLoose(text) {
  const s = String(text ?? '').replace(/```json|```/g, '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(s.slice(i, j + 1));
  } catch {
    return null;
  }
}

/** 调工作站 vLLM 生成两段式观察；失败返回 { fields:null, err }。 */
async function synthesizeObservation(material) {
  if (!LLM.enabled) return { fields: null, ms: 0, err: 'disabled' };
  if (!LLM.baseUrl || !LLM.model) return { fields: null, ms: 0, err: 'unconfigured' };
  const key = loadKey();
  if (!key) return { fields: null, ms: 0, err: 'no-key' };
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LLM.timeoutMs);
  try {
    const resp = await fetch(`${LLM.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      signal: ac.signal,
      body: JSON.stringify({
        model: LLM.model,
        temperature: 0.2,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: LLM_SYSTEM },
          { role: 'user', content: typeof material === 'string' ? material : JSON.stringify(material) },
        ],
        // 工作站自建 vLLM：关思考省 token（云端 API 传未知参数会被拒，此处只跑自建端点）
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const fields = parseJsonLoose(data?.choices?.[0]?.message?.content);
    if (!fields || typeof fields.user_action !== 'string') {
      return { fields: null, ms: Date.now() - started, err: 'unparsable' };
    }
    const clip = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
    return {
      fields: {
        user_action: clip(fields.user_action),
        assistant_action: clip(fields.assistant_action),
      },
      ms: Date.now() - started,
      err: '',
    };
  } catch (err) {
    return { fields: null, ms: Date.now() - started, err: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ============ 检索机制（对齐 pi extensions/memory_search.ts，2026-11-10） ============
// 链路：jieba 分词 → segmented_text → FTS5(BM25) 召回 → 向量(embedding)独立召回
//       → 加权 RRF 融合 + 稀有词精确命中加分
const EMB = CONFIG.embed;
const RRF_K = 60;
const MAX_TERMS = 20;
// 停用词/判别力过滤：OR 掉全部 token 会命中大半语料，BM25 失去判别力
const STOP_CHAR = new Set(
  '的了是在我有和就不也很到说要去你会着看好这那他她它们个与及等或被把让给从对为以而则其之此该都还又再才已没未太更最些么吗呢吧啊呀'.split('')
);
const STOP_EN = new Set([
  'the','a','an','of','to','in','for','and','or','is','are','was','were','be','been','it','this','that',
  'with','as','at','by','from','on','how','what','why','can','do','does','i','we','you','they','not','but','if','so',
]);
const STOP_WORD = new Set([
  '怎么','什么','为什么','如何','可以','能够','需要','应该','但是','因为','所以','如果','然后','现在','还是',
  '可能','已经','觉得','知道','进行','使用','一个','一些','这样','那样','这些','那些','之后','之前','时候',
  '问题','情况','方法','方式','东西','地方','我们','你们','他们','它们','这个','那个','没有','不是','就是',
  '好像','大概','也许','一定','之类','而已','其实','反正','基本','主要','一般',
]);

/** jieba 切词 → 空格连接，写入 observations.segmented_text 供 FTS5 索引。 */
function segment(text) {
  try {
    return cutForSearch(String(text ?? ''), true).join(' ');
  } catch (err) {
    log(`segment failed: ${err?.message ?? err}`);
    return '';
  }
}

/** 查询词：jieba 切词 → 停用词/单字过滤。 */
function ftsTerms(text) {
  let raw;
  try {
    raw = [...new Set(cutForSearch(String(text ?? ''), true).map((w) => w.trim()).filter(Boolean))];
  } catch {
    raw = String(text ?? '').split(/\s+/).filter(Boolean);
  }
  const kept = [];
  for (const w of raw) {
    const lw = w.toLowerCase();
    if (STOP_WORD.has(w) || STOP_EN.has(lw) || STOP_CHAR.has(w)) continue;
    if (w.length < 2 && !/^\d{1,3}$/.test(w)) continue;
    kept.push(w);
    if (kept.length >= MAX_TERMS) break;
  }
  return kept.length ? kept : raw.slice(0, 8);
}

/** 逐词加双引号：防止 vLLM / E:/path / fp8-kv 里的符号破坏 FTS5 语法。 */
function ftsExprFromTerms(terms) {
  return terms.map((w) => `"${String(w).replace(/"/g, '""')}"`).join(' OR ');
}

/** 调 embedding 端点取向量；失败返回 null（检索退化为纯关键词）。 */
async function embedText(text) {
  if (!EMB.enabled) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EMB.timeoutMs);
    const res = await fetch(EMB.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMB.model, input: String(text ?? '').slice(0, 1500) }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    // 兼容两种常见响应：{ data: [{ embedding: [...] }] } 与 { embeddings: [[...]] }
    const vec = data?.data?.[0]?.embedding ?? data?.embeddings?.[0];
    if (!Array.isArray(vec) || !vec.length) return null;
    return new Float32Array(vec);
  } catch {
    return null;
  }
}

function blobToVec(buf) {
  if (!buf || !buf.byteLength) return null;
  try {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  } catch {
    return null;
  }
}

function vecToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const BASE = '/memory-probe';
const PAGE_PATH = `${BASE}/`;
const JSON_PATH = `${BASE}/observations.json`;
const STREAM_PATH = `${BASE}/stream`;
const SUMMARIES_PATH = `${BASE}/summaries.json`;
const UPDATE_PATH = `${BASE}/observations/update`;
const DELETE_PATH = `${BASE}/observations/delete`;
const DISMISSED_PATH = `${BASE}/dismissed.json`;
const UNDISMISS_PATH = `${BASE}/observations/undismiss`;

let db = null;
/** SSE 订阅者：res → 会话过滤键（null = 全部） */
const clients = new Map();

function ensureDir() {
  try {
    mkdirSync(DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function log(line) {
  try {
    ensureDir();
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

function getDb() {
  if (db) return db;
  ensureDir();
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn INTEGER,
      time INTEGER,
      user_action TEXT,
      assistant_action TEXT,
      tools TEXT,
      note TEXT,
      source TEXT
    );
  `);
  // 结构化观察字段（老库自动补列）
  for (const col of ['intent', 'did', 'outcome', 'open_note', 'keep_note']) {
    try {
      db.exec(`ALTER TABLE observations ADD COLUMN ${col} TEXT`);
    } catch {
      /* 已存在 */
    }
  }
  // 对账锚点（复刻 pi 的 msg_id 机制：锚点 = 轮尾事件 seq，删除观察 = 锚点回退 → 自动重放）
  try {
    db.exec('ALTER TABLE observations ADD COLUMN anchor_seq INTEGER');
  } catch {
    /* 已存在 */
  }
  // 日/周/月总结（与 pi summarize_sync 同构：daily ← 当日观察；weekly/monthly ← daily 聚合）
  db.exec(`
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      period TEXT NOT NULL,
      mainline TEXT, topics TEXT, stats TEXT,
      created_at TEXT, updated_at TEXT,
      UNIQUE(kind, period)
    );
  `);
  // 总结失败记账：连续失败或「无数据」类失败永久跳过，避免空周期反复霸占批次名额
  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_skip (
      kind TEXT NOT NULL,
      period TEXT NOT NULL,
      reason TEXT,
      attempts INTEGER DEFAULT 0,
      blocked INTEGER DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (kind, period)
    );
  `);

  // 删除墓碑：用户主动删掉的轮次不再自动重放（否则锚点回退会让它又出现）
  db.exec(`
    CREATE TABLE IF NOT EXISTS dismissed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      anchor_seq INTEGER,
      turn INTEGER,
      created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dismissed_sid ON dismissed(session_id);
  `);
  // 跨进程幂等：同一会话同一锚点只允许一条观察（两个进程同时对账也不会重复写）
  try {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_anchor ON observations(session_id, anchor_seq) WHERE anchor_seq IS NOT NULL'
    );
  } catch (err) {
    log(`unique index failed: ${err?.message ?? err}`);
  }

  // ---- 检索增强（对齐 pi memory.db 结构）----
  // segmented_text：jieba 分词结果，FTS5 索引的就是这一列（中文整段不分词会导致关键词召回全废）
  for (const ddl of [
    "ALTER TABLE observations ADD COLUMN segmented_text TEXT DEFAULT ''",
    'ALTER TABLE observations ADD COLUMN embedding BLOB',
    'ALTER TABLE observations ADD COLUMN embedding_model TEXT',
  ]) {
    try {
      db.exec(ddl);
    } catch {
      /* 已存在 */
    }
  }
  // FTS 索引 schema 版本：v2 起用「外部内容表 + 分词列」。
  // 老库（先有数据后建索引）会出现索引与内容表不一致，UPDATE 时报 database disk image is malformed，
  // 所以迁移时强制 DROP 重建一次，之后按常规 IF NOT EXISTS 维护。
  const FTS_SCHEMA_VERSION = 2;
  try {
    const ver = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (ver < FTS_SCHEMA_VERSION) {
      db.exec('DROP TRIGGER IF EXISTS obs_ai; DROP TRIGGER IF EXISTS obs_au; DROP TRIGGER IF EXISTS obs_ad;');
      db.exec('DROP TABLE IF EXISTS observations_fts;');
      log(`fts schema migrate: v${ver} -> v${FTS_SCHEMA_VERSION}`);
    }
  } catch (err) {
    log(`fts migrate check failed: ${err?.message ?? err}`);
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        segmented_text,
        content='observations',
        content_rowid='id',
        tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
        INSERT INTO observations_fts(rowid, segmented_text) VALUES (new.id, new.segmented_text);
      END;
      CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, segmented_text) VALUES('delete', old.id, old.segmented_text);
        INSERT INTO observations_fts(rowid, segmented_text) VALUES (new.id, new.segmented_text);
      END;
      CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
        INSERT INTO observations_fts(observations_fts, rowid, segmented_text) VALUES('delete', old.id, old.segmented_text);
      END;
    `);
  } catch (err) {
    log(`fts init failed: ${err?.message ?? err}`);
  }
  // 首建 FTS 表或索引落后于数据时重建（外部内容表不会自动回填历史行）
  try {
    const ftsCount = Number(db.prepare('SELECT COUNT(*) c FROM observations_fts').get()?.c ?? 0);
    const obsCount = Number(db.prepare('SELECT COUNT(*) c FROM observations').get()?.c ?? 0);
    if (ftsCount < obsCount) {
      db.exec("INSERT INTO observations_fts(observations_fts) VALUES('rebuild')");
      log(`fts rebuild: ${ftsCount} -> ${obsCount}`);
    }
  } catch (err) {
    log(`fts rebuild failed: ${err?.message ?? err}`);
  }
  try {
    db.exec(`PRAGMA user_version = ${FTS_SCHEMA_VERSION}`);
  } catch {
    /* 忽略 */
  }
  return db;
}

/** 单条事件 → 一行 JSONL（与 pi observe_sync 同构：结构化消息流，而非压成一段话）。 */
function entryJsonl(ev, lims, names) {
  const d = ev?.data ?? {};
  switch (ev?.type) {
    case 'user/message': {
      // 只取真人输入：runtime-context / skill-catalog 是宿主注入的上下文块
      if (d.source?.kind !== 'user') return null;
      const t = textOf(d.content);
      if (!t) return null;
      return JSON.stringify({ role: 'user', content: clip(t, lims.user) });
    }
    case 'assistant/message': {
      const parts = [];
      for (const b of d.message?.content ?? []) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && String(b.text ?? '').trim()) {
          parts.push({ type: 'text', text: clip(b.text, lims.ast) });
        }
      }
      if (!parts.length) {
        // 纯工具调用的步骤（无正文）不单独成行，工具事件另有记录
        return null;
      }
      const line = { role: 'assistant', content: parts };
      if (d.interrupted) line.note = '[助手回复被用户打断]';
      return JSON.stringify(line);
    }
    case 'tool/call': {
      if (!d.name) return null;
      return JSON.stringify({
        role: 'toolCall',
        name: d.name,
        arguments: clip(String(d.arguments ?? ''), lims.args),
      });
    }
    case 'tool/result': {
      const raw = textOf(d.message?.content);
      const callId = d.message?.source?.callId;
      const toolName = (callId && names?.get(callId)) || d.name || 'tool';
      const line = { role: 'toolResult', toolName, content: clip(raw, lims.result) };
      if (d.error) line.note = `[工具失败${d.error.name ? ': ' + d.error.name : ''}]`;
      return JSON.stringify(line);
    }
    default:
      return null;
  }
}

/** 窗口内 callId → 工具名（tool/result 事件本身只带 callId，名字要从 tool/call 推断）。 */
function toolNameMap(events) {
  const m = new Map();
  for (const ev of events) {
    if (ev?.type === 'tool/call' && ev.data?.callId && ev.data?.name) m.set(ev.data.callId, ev.data.name);
  }
  return m;
}

/** 给定裁切上限时，窗口序列化后的总字符数。 */
function windowChars(events, lims) {
  const names = toolNameMap(events);
  let n = 0;
  for (const ev of events) {
    const line = entryJsonl(ev, lims, names);
    if (line) n += line.length + 20;
  }
  return n;
}

/**
 * 预算自适应（同 pi fitLims）：超 60000 字符时先压工具字符（args/result 有下限），
 * user/assistant 正文骨架不动；极端超长才四类等比压缩。
 */
function fitLims(events) {
  const lims = { user: LIM_USER, ast: LIM_AST, args: LIM_ARGS, result: LIM_RESULT };
  let total = windowChars(events, lims);
  if (total <= BUDGET_CHARS) return lims;
  while (total > BUDGET_CHARS && (lims.args > FLOOR_ARGS || lims.result > FLOOR_RESULT)) {
    const f = (BUDGET_CHARS - 200) / total; // 200 字符结构余量
    lims.args = Math.max(FLOOR_ARGS, Math.floor(lims.args * f));
    lims.result = Math.max(FLOOR_RESULT, Math.floor(lims.result * f));
    total = windowChars(events, lims);
  }
  if (total <= BUDGET_CHARS) return lims;
  const f2 = (BUDGET_CHARS - 200) / total;
  lims.args = Math.max(20, Math.floor(lims.args * f2));
  lims.result = Math.max(40, Math.floor(lims.result * f2));
  lims.user = Math.max(200, Math.floor(lims.user * f2));
  lims.ast = Math.max(200, Math.floor(lims.ast * f2));
  return lims;
}

/** 本会话近期观察（旧→新），给观察员做背景，防重复/防断链。 */
function recentObservations(sessionId, limit = RECENT_OBS) {
  try {
    const rows = getDb()
      .prepare(
        "SELECT turn, user_action, assistant_action FROM observations WHERE lower(replace(session_id, 'session-', '')) = ? ORDER BY id DESC LIMIT ?"
      )
      .all(normSession(sessionId), limit);
    if (!rows.length) return '';
    const lines = [];
    let used = 0;
    for (const r of rows) {
      const line = `- 第${r.turn ?? '?'}轮 | 用户：${r.user_action} ｜ 助手：${r.assistant_action}`;
      if (used + line.length > RECENT_OBS_CHARS) break;
      lines.push(line);
      used += line.length;
    }
    return lines.reverse().join('\n');
  } catch (err) {
    log(`recentObservations failed: ${err?.message ?? err}`);
    return '';
  }
}

/** 按本轮步数给出输出篇幅建议（参考值，不是硬上限）。 */
function suggestLength(steps) {
  if (steps <= 5) return { user: '约 40~80 字', ast: '约 80~150 字' };
  if (steps <= 20) return { user: '约 80~180 字', ast: '约 200~400 字' };
  return { user: '约 150~250 字', ast: '约 400~800 字' };
}

/** 拼观察员输入：近期观察 → 本轮规模建议 → 对话窗口 JSONL → 指令。 */
function buildPrompt(sessionId, events) {
  const lims = fitLims(events);
  const parts = [];
  const recent = recentObservations(sessionId);
  if (recent) parts.push(`## 近期观察记录(旧→新)\n${recent}`);

  let steps = 0;
  let toolCalls = 0;
  for (const ev of events) {
    if (ev?.type === 'step/start') steps += 1;
    else if (ev?.type === 'tool/call') toolCalls += 1;
  }
  const suggest = suggestLength(steps);
  parts.push(
    `## 本轮规模\n步数 ${steps}、工具调用 ${toolCalls} 次、窗口 ${events.length} 条事件。\n` +
      `建议篇幅：user_action ${suggest.user}，assistant_action ${suggest.ast}（步数多、中间过程多的轮次应当写细，不要缩水；信息量不足时宁可短）。`
  );

  parts.push('## 对话窗口(自上次观察以来的增量, JSONL 格式, 每行一条)');
  let lines = 0;
  const names = toolNameMap(events);
  for (const ev of events) {
    const line = entryJsonl(ev, lims, names);
    if (line) {
      parts.push(line);
      lines += 1;
    }
  }
  parts.push('\n\n以上是自上次观察以来的全部增量。请综合分析这段工作，只输出一行 JSON：{"user_action":"…","assistant_action":"…"}，不要输出其他文字。');
  return { prompt: parts.join('\n'), lines, steps, chars: windowChars(events, lims), lims };
}

// ── 日/周/月总结（口径同 pi summarize_sync：daily←当日观察；weekly/monthly←daily 聚合） ──
const TZ_MS = 8 * 3600 * 1000;
const SUMMARY_START_MS = 90 * 1000;          // 启动后首次扫描延迟（等会话稳定）
const SUMMARY_INTERVAL_MS = 30 * 60 * 1000;  // 之后每 30 分钟扫一次缺漏
const SUMMARY_MAX_INPUT = 60000;             // 单次总结喂料上限（字符）
const SUMMARY_BATCH = 3;                     // 每次 tick 最多生成几份，避免打爆 vLLM

function dateStr(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  return new Date(n + TZ_MS).toISOString().slice(0, 10);
}
function todayStr() { return dateStr(Date.now()); }
function dateAdd(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function mondayOf(d) {
  const wd = new Date(d + 'T00:00:00Z').getUTCDay(); // 0=周日
  return dateAdd(d, -((wd + 6) % 7));
}
function nextMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/** 通用 LLM 调用（与 observe 同一端点/密钥，可指定 system 与 max_tokens）。 */
async function callLlmText(system, user, maxTokens = 2000) {
  if (!LLM.enabled) throw new Error('disabled');
  if (!LLM.baseUrl || !LLM.model) throw new Error('unconfigured');
  const key = loadKey();
  if (!key) throw new Error('no-key');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LLM.timeoutMs * 3);
  try {
    const resp = await fetch(`${LLM.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      signal: ac.signal,
      body: JSON.stringify({
        model: LLM.model,
        temperature: 0.3,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new Error('空响应');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 某日全部观察 → 喂料文本 + 统计行。 */
function dailyInput(period) {
  const rows = getDb()
    .prepare(
      "SELECT turn, time, session_id, user_action, assistant_action, tools FROM observations WHERE date(time/1000,'unixepoch','+8 hours') = ? ORDER BY time"
    )
    .all(period);
  if (!rows.length) return { text: '', nSessions: 0 };
  const sessions = new Set(rows.map((r) => normSession(r.session_id)));
  const parts = [];
  let used = 0;
  for (const r of rows) {
    const hhmm = new Date(Number(r.time) + TZ_MS).toISOString().slice(11, 16);
    let line = `- [${hhmm}] ${normSession(r.session_id).slice(0, 8)} 第${r.turn ?? '?'}轮 | 用户：${r.user_action || '（无）'}｜助手：${r.assistant_action || '（无）'}`;
    if (r.tools) line += `（工具：${r.tools}）`;
    if (used + line.length > SUMMARY_MAX_INPUT) {
      parts.push(`…[当日共 ${rows.length} 条观察，已省略后续 ${rows.length - parts.length} 条]…`);
      break;
    }
    parts.push(line);
    used += line.length;
  }
  return { text: parts.join('\n'), nSessions: sessions.size, total: rows.length };
}

/** 周/月：从 daily 总结聚合。 */
function summariesInput(from, to) {
  const rows = getDb()
    .prepare("SELECT period, mainline, topics FROM summaries WHERE kind='daily' AND period >= ? AND period < ? ORDER BY period")
    .all(from, to);
  const parts = [];
  let used = 0;
  for (const r of rows) {
    let block = `== ${r.period} ==\n主线: ${r.mainline || ''}`;
    try {
      const topics = JSON.parse(r.topics || '[]');
      if (Array.isArray(topics) && topics.length) {
        block += '\n主题:\n' + topics.map((t) => `- ${t.title}\n  ${String(t.content ?? '').slice(0, 800)}`).join('\n');
      }
    } catch {
      /* 无 topics */
    }
    if (used + block.length > SUMMARY_MAX_INPUT) {
      parts.push(`…[共 ${rows.length} 天，已省略后续]…`);
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return { text: parts.join('\n\n'), days: rows.length };
}

const SUMMARY_SYSTEM = [
  '你是对话总结员，把原始记录压缩成结构化总结。',
  '只输出一行 JSON，不要 markdown 代码块，不要任何其他文字：',
  '{"mainline":"...","topics":[{"title":"...","sids":["..."],"content":"..."}]}',
  '',
  '- mainline：主线综述，100~300 字，多个成果用分号分隔；必须写具体结论和数值（如「mIoU 0.8153，证伪该路线」），禁止「取得进展」这类空话。',
  '- topics：3~8 个，按重要性排序；title ≤10 字；sids 仅当输入带会话 id 时原样拄写全值，否则空数组 []；content 用「- 」开头的短行要点，按时间顺序，每条写具体结论/参数/文件名，信息量决定篇幅，宁多勿漏。',
  '- 覆盖全部主要工作线，不得静默丢弃；寒暄、纯流程性内容（重启服务、查状态）丢弃。',
  '- 输入中形如「…[已省略…]…」表示过长被截断，不代表内容到此结束。',
].join('\n');

function summaryUserPrompt(kind, period, body) {
  const ask =
    kind === 'daily'
      ? `请总结 ${period} 这一天的工作。`
      : kind === 'weekly'
        ? `请总结 ${period} 起（${period} ~ ${dateAdd(period, 6)}）一周的工作。`
        : `请总结 ${period} 月的工作。`;
  return `${ask}\n\n${body}\n\n只输出一行 JSON：{"mainline":"...","topics":[{"title":"...","sids":[],"content":"..."}]}`;
}

/** 生成一份总结（日/周/月）并落库；幂等（INSERT OR REPLACE）。 */
async function runSummary(kind, period) {
  let body = '';
  let statLine = '';
  if (kind === 'daily') {
    const d = dailyInput(period);
    if (!d.text) return { ok: false, err: '当日无观察' };
    body = `## ${period} 的观察记录\n\n${d.text}`;
    statLine = `活跃会话 ${d.nSessions} · 观察 ${d.total} 条`;
  } else {
    const from = kind === 'weekly' ? period : period + '-01';
    const to = kind === 'weekly' ? dateAdd(from, 7) : nextMonth(period) + '-01';
    const s = summariesInput(from, to);
    if (!s.text) return { ok: false, err: '无 daily 可聚合' };
    body = `## ${from} ~ ${dateAdd(to, -1)} 的每日总结\n\n${s.text}`;
    statLine = `覆盖 ${s.days} 天`;
  }
  const user = summaryUserPrompt(kind, period, body);
  let data = null;
  let lastErr = '';
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    try {
      const raw = await callLlmText(SUMMARY_SYSTEM, user, 2400);
      let obj = null;
      try { obj = parseJsonLoose(raw); } catch { obj = null; }
      if (obj && typeof obj.mainline === 'string') {
        data = { mainline: obj.mainline, topics: Array.isArray(obj.topics) ? obj.topics : [] };
      } else {
        const fixed = await callLlmText(
          SUMMARY_SYSTEM,
          user + '\n\n你上次的输出无法解析，只输出一行纯 JSON：{"mainline":"...","topics":[{"title":"...","sids":[],"content":"..."}]}',
          2400
        );
        const obj2 = parseJsonLoose(fixed);
        if (obj2 && typeof obj2.mainline === 'string') {
          data = { mainline: obj2.mainline, topics: Array.isArray(obj2.topics) ? obj2.topics : [] };
        }
      }
    } catch (e) {
      lastErr = e?.message ?? String(e);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  if (!data) return { ok: false, err: `LLM 失败: ${lastErr}` };
  const now = new Date(Date.now() + TZ_MS).toISOString().slice(0, 19).replace('T', ' ');
  getDb()
    .prepare(
      `INSERT INTO summaries (kind, period, mainline, topics, stats, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(kind, period) DO UPDATE SET mainline=excluded.mainline, topics=excluded.topics,
         stats=excluded.stats, updated_at=excluded.updated_at`
    )
    .run(kind, period, data.mainline, JSON.stringify(data.topics), statLine, now, now);
  return { ok: true, stats: `${data.topics.length} 主题 · ${statLine}` };
}

/** 找出所有缺漏任务：daily 按日、weekly/monthly 要求区间内每一天都已 covered。 */
function collectPendingSummaries() {
  const conn = getDb();
  const today = todayStr();
  const obsDates = new Set(
    conn
      .prepare("SELECT DISTINCT date(time/1000,'unixepoch','+8 hours') d FROM observations WHERE time IS NOT NULL AND time > 0")
      .all()
      .map((r) => r.d)
      .filter(Boolean)
  );
  const days = [...obsDates].sort();
  if (!days.length) return [];
  const have = (kind) => new Set(conn.prepare('SELECT period FROM summaries WHERE kind=?').all(kind).map((r) => r.period));
  const haveDaily = have('daily');
  const haveWeekly = have('weekly');
  const haveMonthly = have('monthly');
  const blocked = new Set(
    conn
      .prepare('SELECT kind, period FROM summary_skip WHERE blocked = 1')
      .all()
      .map((r) => `${r.kind} ${r.period}`)
  );
  const tasks = [];

  // daily：过去的日期且有观察、无总结（从旧到新）
  for (const d of days) {
    if (d < today && !haveDaily.has(d) && !blocked.has(`daily ${d}`)) tasks.push({ kind: 'daily', period: d });
  }

  const covered = (d) => haveDaily.has(d);
  const inRange = (from, toExcl) => days.filter((d) => d >= from && d < toExcl);
  const minD = days[0];

  // weekly：已结束的周；且该周真的要「有观察」才入队
  // （旧写法 covered(d)=haveDaily||!obsDates 会把零数据的空周判成已覆盖，导致空周反复入队、
  //   运行必然失败、又不清理，最后把批次名额全占满，合法的 monthly 被饿死）
  let guard = 0;
  for (let w = mondayOf(minD); w < mondayOf(today) && guard++ < 200; w = dateAdd(w, 7)) {
    if (haveWeekly.has(w) || blocked.has(`weekly ${w}`)) continue;
    const wdays = inRange(w, dateAdd(w, 7));
    if (!wdays.length) continue; // 整周无观察：不生成，也不重试
    if (!wdays.every((d) => covered(d))) continue; // 还有没生成的 daily，等下一轮
    tasks.push({ kind: 'weekly', period: w });
  }

  // monthly：已结束的月（直接从 daily 聚合，不依赖 weekly）
  guard = 0;
  for (let m = minD.slice(0, 7); m < today.slice(0, 7) && guard++ < 60; m = nextMonth(m)) {
    if (haveMonthly.has(m) || blocked.has(`monthly ${m}`)) continue;
    const mdays = inRange(m + '-01', nextMonth(m) + '-01');
    if (!mdays.length) continue;
    if (!mdays.every((d) => covered(d))) continue;
    tasks.push({ kind: 'monthly', period: m });
  }

  // 批次优先取从未失败过的任务，避免个别顽固失败项长期垄断名额
  const attempts = new Map(
    conn
      .prepare('SELECT kind, period, attempts FROM summary_skip')
      .all()
      .map((r) => [`${r.kind} ${r.period}`, Number(r.attempts) || 0])
  );
  tasks.sort((a, b) => (attempts.get(`${a.kind} ${a.period}`) ?? 0) - (attempts.get(`${b.kind} ${b.period}`) ?? 0));
  return tasks;
}

/** 记录一次总结失败：连续 3 次或「无数据」类失败 → 永久跳过，避免无限重试刷日志。 */
function recordSummaryFailure(kind, period, reason) {
  try {
    const conn = getDb();
    const row = conn.prepare('SELECT attempts FROM summary_skip WHERE kind = ? AND period = ?').get(kind, period);
    const attempts = Number(row?.attempts ?? 0) + 1;
    const permanent = /无观察|无数据|没有可聚合|无 daily/i.test(String(reason ?? ''));
    const blocked = permanent || attempts >= 3 ? 1 : 0;
    conn
      .prepare(
        `INSERT INTO summary_skip (kind, period, reason, attempts, blocked, updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(kind, period) DO UPDATE SET reason=?, attempts=?, blocked=?, updated_at=?`
      )
      .run(kind, period, String(reason ?? '').slice(0, 200), attempts, blocked, new Date().toISOString(),
           String(reason ?? '').slice(0, 200), attempts, blocked, new Date().toISOString());
    if (blocked) log(`summary skip ${kind} ${period} (attempts=${attempts}): ${reason}`);
  } catch (err) {
    log(`recordSummaryFailure failed: ${err?.message ?? err}`);
  }
}

function clearSummaryFailure(kind, period) {
  try {
    getDb().prepare('DELETE FROM summary_skip WHERE kind = ? AND period = ?').run(kind, period);
  } catch {
    /* 忽略 */
  }
}

let summaryBusy = false;

/** 定时扫描缺漏并生成；启动后 90s 首次，之后每 30 分钟。 */
function startSummaryScheduler() {
  const tick = async () => {
    if (summaryBusy) return;
    summaryBusy = true;
    try {
      const tasks = collectPendingSummaries();
      if (!tasks.length) return;
      log(`summary pending ${tasks.length}: ${tasks.map((t) => t.kind + ' ' + t.period).join(', ')}`);
      for (const t of tasks.slice(0, SUMMARY_BATCH)) {
        const r = await runSummary(t.kind, t.period);
        if (r.ok) clearSummaryFailure(t.kind, t.period);
        else recordSummaryFailure(t.kind, t.period, r.err);
        log(`summary ${t.kind} ${t.period}: ${r.ok ? 'ok ' + (r.stats || '') : 'fail ' + (r.err || '')}`);
      }
    } catch (e) {
      log(`summary tick error: ${e?.message ?? e}`);
    } finally {
      summaryBusy = false;
    }
  };
  const first = setTimeout(tick, SUMMARY_START_MS);
  const timer = setInterval(tick, SUMMARY_INTERVAL_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  log(`summary scheduler started (first in ${SUMMARY_START_MS / 1000}s, interval ${SUMMARY_INTERVAL_MS / 60000}min)`);
}

const BACKFILL_START_MS = 20 * 1000;
const BACKFILL_INTERVAL_MS = 5 * 60 * 1000;

/** 存量索引补齐：分词缺失即刻补，向量缺失分批补（每分钟最多 40 条，避免拖慢观察生成）。 */
function startBackfillScheduler() {
  const tick = async () => {
    try {
      await backfillWorker(200);
    } catch (err) {
      log(`backfill tick error: ${err?.message ?? err}`);
    }
  };
  const first = setTimeout(tick, BACKFILL_START_MS);
  const timer = setInterval(tick, BACKFILL_INTERVAL_MS);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  log(`backfill scheduler started (first in ${BACKFILL_START_MS / 1000}s, interval ${BACKFILL_INTERVAL_MS / 60000}min)`);
}

/** 读总结（kind 为空 = 全部）。 */
function readSummaries(kind, limit) {
  try {
    const conn = getDb();
    if (kind) return conn.prepare('SELECT * FROM summaries WHERE kind=? ORDER BY period DESC LIMIT ?').all(kind, limit);
    return conn.prepare('SELECT * FROM summaries ORDER BY period DESC LIMIT ?').all(limit);
  } catch (err) {
    log(`readSummaries failed: ${err?.message ?? err}`);
    return [];
  }
}

/** 分层记忆唤醒文本（学 pi memory_wake：时间锚点 + 日/周/月主线 + 观察提示）。 */
function buildWakeText() {
  const conn = getDb();
  const now = new Date(Date.now() + TZ_MS);
  const stamp = now.toISOString().slice(0, 19).replace('T', ' ');
  const lines = [`【当前时间】${stamp}（UTC+8）`];
  const pick = (kind, n, since) => {
    const sql = since
      ? 'SELECT period, mainline FROM summaries WHERE kind=? AND period>=? ORDER BY period DESC LIMIT ?'
      : 'SELECT period, mainline FROM summaries WHERE kind=? ORDER BY period DESC LIMIT ?';
    const rows = since ? conn.prepare(sql).all(kind, since, n) : conn.prepare(sql).all(kind, n);
    return rows.reverse();
  };
  // 时间窗口：日总结取近 7 天、周总结近 4 周、月总结近 6 个月，避免陈旧总结占满注入
  const sections = [
    ['daily', '每日总结', 7, dateAdd(dateStr(Date.now()), -6)],
    ['weekly', '每周总结', 4, dateAdd(dateStr(Date.now()), -27)],
    ['monthly', '月度总结', 6, null],
  ];
  let got = 0;
  for (const [kind, label, n, since] of sections) {
    const rows = pick(kind, n, since);
    if (!rows.length) continue;
    lines.push(`【${label}】`);
    for (const r of rows) lines.push(`- ${r.period}：${r.mainline || ''}`);
    got += rows.length;
  }
  if (!got) lines.push('【总结】暂无（日/周/月总结会在周期结束后自动生成）');

  const today = dateStr(Date.now());
  let todayCount = 0;
  let totalCount = 0;
  try {
    todayCount = conn.prepare("SELECT COUNT(*) n FROM observations WHERE date(time/1000,'unixepoch','+8 hours')=?").get(today).n;
    totalCount = conn.prepare('SELECT COUNT(*) n FROM observations').get().n;
  } catch {
    /* ignore */
  }
  lines.push(`【观察日志】今日 ${todayCount} 条、累计 ${totalCount} 条。需要某段工作的明细时用 memory_search 检索（按关键词/会话）。`);
  return lines.join('\n');
}

/** 会话清单：每个会话的观察数、轮次范围、首末时间（帮模型定位「哪次会话做过什么」）。 */
function listSessions(limit = 30) {
  const conn = getDb();
  try {
    return conn
      .prepare(
        `SELECT session_id,
                COUNT(*) AS n,
                MIN(turn) AS min_turn,
                MAX(turn) AS max_turn,
                MIN(time) AS first_time,
                MAX(time) AS last_time
           FROM observations
          GROUP BY session_id
          ORDER BY last_time DESC
          LIMIT ?`
      )
      .all(limit);
  } catch (err) {
    log(`listSessions failed: ${err?.message ?? err}`);
    return [];
  }
}

function buildWhere(sid, since, until, alias) {
  const where = [];
  const params = [];
  const p = alias ? `${alias}.` : '';
  if (sid) {
    where.push(`lower(replace(${p}session_id, 'session-', '')) LIKE ?`);
    params.push(`%${sid}%`);
  }
  if (since) {
    where.push(`date(${p}time/1000,'unixepoch','+8 hours') >= ?`);
    params.push(String(since));
  }
  if (until) {
    where.push(`date(${p}time/1000,'unixepoch','+8 hours') <= ?`);
    params.push(String(until));
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * 观察检索（与 pi memory_search.ts 同构）：
 *   关键词路 = jieba 分词 → 停用词过滤 → FTS5 BM25 top N
 *   语义路   = embedding 向量 → 全量余弦 top N（独立召回，字面不匹配也能进池）
 *   融合     = 加权 RRF（1/(60+名次)）+ 稀有词精确命中加分
 * 另支持：时间范围、会话片段、无关键词按时间浏览、按会话聚合。
 */
async function searchObservations(opts = {}) {
  const { query = '', session = '', since = '', until = '', limit = 20, groupBySession = false, semanticOnly = false } = opts;
  const conn = getDb();
  const sid = normSession(session);
  const n = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const plain = buildWhere(sid, since, until, '');
  const aliased = buildWhere(sid, since, until, 'o');

  const q = String(query ?? '').trim();
  if (!q) {
    try {
      if (groupBySession) {
        return conn
          .prepare(
            `SELECT session_id, COUNT(*) AS hits, MIN(turn) AS min_turn, MAX(turn) AS max_turn,
                    MIN(time) AS first_time, MAX(time) AS last_time
               FROM observations ${plain.sql}
              GROUP BY session_id ORDER BY hits DESC LIMIT ?`
          )
          .all(...plain.params, n);
      }
      return conn.prepare(`SELECT * FROM observations ${plain.sql} ORDER BY time DESC LIMIT ?`).all(...plain.params, n);
    } catch (err) {
      log(`browse failed: ${err?.message ?? err}`);
      return [];
    }
  }

  const terms = ftsTerms(q);
  const expr = ftsExprFromTerms(terms);
  const qvec = await embedText(q);
  const pool = new Map();
  const ftsRank = new Map();
  const vecRank = new Map();
  const rareBonus = new Map();
  let wFts = 1;
  let topSim = 0;
  let ftsHits = 0;
  const cond = aliased.sql ? `${aliased.sql} AND` : 'WHERE';

  // ---- 路 1：关键词召回（FTS5 BM25）----
  if (expr && !semanticOnly) {
    try {
      const cntSql = `SELECT COUNT(*) c FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
        ${cond} observations_fts MATCH ?`;
      // 判别力取最稀有的词：0.8153 这类命中 1 条时，关键词路应当压过语义路
      let minHits = Number.MAX_SAFE_INTEGER;
      const termHits = new Map();
      for (const t of terms.slice(0, 8)) {
        try {
          const c1 = Number(conn.prepare(cntSql).get(...aliased.params, ftsExprFromTerms([t]))?.c ?? 0);
          termHits.set(t, c1);
          if (c1) minHits = Math.min(minHits, c1);
        } catch {
          /* 单词语法问题忽略 */
        }
      }
      wFts = minHits <= 20 ? 1.2 : 0.85;

      // 稀有词定向加分：只奖励真正含该 token 的记录（整体加权会被泛词结果搭便车）
      const idSql = `SELECT o.id FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
        ${cond} observations_fts MATCH ? LIMIT 60`;
      for (const t of terms.slice(0, 8)) {
        const c1 = termHits.get(t) ?? 0;
        if (!c1 || c1 > 20) continue;
        const bonus = c1 <= 5 ? 0.05 : 0.02;
        try {
          for (const r of conn.prepare(idSql).all(...aliased.params, ftsExprFromTerms([t]))) {
            const id = Number(r.id);
            rareBonus.set(id, (rareBonus.get(id) ?? 0) + bonus);
          }
        } catch {
          /* 忽略 */
        }
      }

      const rows = conn
        .prepare(
          `SELECT o.* FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
            ${cond} observations_fts MATCH ?
            ORDER BY bm25(observations_fts) LIMIT ?`
        )
        .all(...aliased.params, expr, Math.max(n * 6, 120));
      ftsHits = rows.length;
      rows.forEach((r, i) => {
        ftsRank.set(Number(r.id), i);
        pool.set(Number(r.id), r);
      });
    } catch (err) {
      log(`fts search failed: ${err?.message ?? err}`);
    }
  }

  // ---- 路 2：语义召回（全量余弦，独立于关键词命中）----
  if (qvec) {
    try {
      const rows = conn.prepare(`SELECT o.* FROM observations o ${aliased.sql}`).all(...aliased.params);
      // 保底相似度：只挡掉彻底无关的向量（余弦排序永远有第一名）。
      // 同一模型下 dsh 库无关查询 top≈0.26、pi 库≈0.42，绝对阈值无法通用，
      // 因此只设很低的保底，真正区分交给输出层的「无字面命中」警示。
      const MIN_SIM = CONFIG.search.minSim;
      const scored = [];
      for (const r of rows) {
        const v = blobToVec(r.embedding);
        if (!v) continue;
        const sim = cosine(qvec, v);
        if (sim > topSim) topSim = sim;
        if (sim < MIN_SIM) continue;
        scored.push({ id: Number(r.id), sim, row: r });
      }
      scored.sort((a, b) => b.sim - a.sim);
      scored.slice(0, Math.max(n * 6, 120)).forEach((s2, i) => {
        vecRank.set(s2.id, i);
        if (!pool.has(s2.id)) pool.set(s2.id, s2.row);
      });
    } catch (err) {
      log(`vector search failed: ${err?.message ?? err}`);
    }
  }

  // ---- 按会话聚合：用关键词命中的 id 聚合（语义池太大不适合做主题定位）----
  if (groupBySession) {
    const ids = [...ftsRank.keys()];
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    try {
      return conn
        .prepare(
          `SELECT session_id, COUNT(*) AS hits, MIN(turn) AS min_turn, MAX(turn) AS max_turn,
                  MIN(time) AS first_time, MAX(time) AS last_time
             FROM observations WHERE id IN (${marks})
            GROUP BY session_id ORDER BY hits DESC LIMIT ?`
        )
        .all(...ids, n);
    } catch (err) {
      log(`group search failed: ${err?.message ?? err}`);
      return [];
    }
  }

  // ---- 融合：加权 RRF + 稀有词奖励 ----
  const fused = [...pool.entries()].map(([id, row]) => ({
    row,
    score:
      (ftsRank.has(id) ? wFts / (RRF_K + ftsRank.get(id)) : 0) +
      (vecRank.has(id) ? 1 / (RRF_K + vecRank.get(id)) : 0) +
      (rareBonus.get(id) ?? 0),
  }));
  fused.sort((a, b) => b.score - a.score);
  const out = fused.slice(0, n).map((x) => x.row);
  // 仍返回数组（保持旧调用兼容），元信息挂在数组对象上供工具层判断
  out.ftsHits = ftsHits;
  out.topSim = topSim;
  out.terms = terms.length;
  return out;
}

/** 从一轮的事件缓冲里抽事实，拼成一条「模拟观察」（纯规则，不调模型）。 */
function buildObservation(sessionId, events) {
  let turn = null;
  let startedAt = null;
  let endedAt = null;
  let steps = 0;
  const userTexts = [];
  const assistantTexts = [];
  const toolCalls = [];

  for (const ev of events) {
    const d = ev?.data ?? {};
    switch (ev?.type) {
      case 'turn/start':
        turn = d.turn ?? turn;
        startedAt = ev.time ?? startedAt;
        break;
      case 'turn/end':
        endedAt = ev.time ?? endedAt;
        break;
      case 'step/start':
        steps += 1;
        break;
      case 'user/message': {
        // 只取真人输入：runtime-context / skill-catalog 是宿主注入的上下文块
        if (d.source?.kind !== 'user') break;
        const t = textOf(d.content);
        if (t) userTexts.push(t);
        break;
      }
      case 'assistant/message': {
        const t = textOf(d.message?.content);
        if (t) assistantTexts.push(t);
        break;
      }
      case 'tool/call':
        if (d.name) toolCalls.push(d.name);
        break;
      default:
        break;
    }
  }

  const userAction = clip(userTexts.join(' | '), 300);
  const assistantAction = clip(assistantTexts.join('\n'), 600);
  const tools = [...new Set(toolCalls)];
  const durationMs = startedAt && endedAt ? endedAt - startedAt : null;

  const note = [
    `第 ${turn ?? '?'} 轮`,
    `用户：${userAction || '（无文本）'}`,
    `助手：${steps} 步 / 工具 ${toolCalls.length} 次${tools.length ? `（${tools.join('、')}）` : ''}`,
    durationMs !== null ? `耗时 ${(durationMs / 1000).toFixed(1)}s` : null,
    assistantAction ? `产出：${assistantAction}` : null,
  ]
    .filter(Boolean)
    .join('；');

  return {
    session_id: String(sessionId ?? 'unknown'),
    turn: turn ?? null,
    time: endedAt ?? Date.now(),
    user_action: userAction,
    assistant_action: assistantAction,
    tools: tools.join(','),
    note,
    source: 'mock-rule-v1',
  };
}

// ── 会话事件缓存（重放源）────────────────────────────────
// dsh 插件只能收到实时事件；要像 pi 一样「删了能自动补齐」，必须自带一份可重放的事件流。
const CACHE_TEXT_MAX = 20000;

/** 只保留观察需要的内容；image/file/reasoning 不进缓存（体积大且无信息价值）。 */
function scrubEvent(event) {
  const d = event?.data ?? {};
  const blocks = (list) =>
    Array.isArray(list)
      ? list
          .map((b) => {
            if (!b || typeof b !== 'object') return null;
            if (b.type === 'text') return { type: 'text', text: String(b.text ?? '').slice(0, CACHE_TEXT_MAX) };
            if (b.type === 'tool-call')
              return { type: 'tool-call', id: b.id, name: b.name, arguments: String(b.arguments ?? '').slice(0, 4000) };
            return null;
          })
          .filter(Boolean)
      : [];
  switch (event?.type) {
    case 'user/message':
      return { content: blocks(d.content), source: d.source };
    case 'assistant/message':
      return { message: { content: blocks(d.message?.content) }, interrupted: d.interrupted || undefined };
    case 'tool/call':
      return { turn: d.turn, step: d.step, callId: d.callId, name: d.name, arguments: String(d.arguments ?? '').slice(0, 4000) };
    case 'tool/result':
      return {
        turn: d.turn,
        step: d.step,
        message: { content: blocks(d.message?.content), source: d.message?.source },
        error: d.error || undefined,
      };
    case 'turn/start':
    case 'turn/end':
      return { turn: d.turn };
    case 'step/start':
      return { turn: d.turn, step: d.step };
    default:
      return null;
  }
}

function cacheFile(sid) {
  return join(CACHE_DIR, `${String(sid).replace(/[^\w.-]/g, '_')}.jsonl`);
}

function cacheEvent(sid, event) {
  const data = scrubEvent(event);
  if (!data) return;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    appendFileSync(cacheFile(sid), JSON.stringify({ seq: event.seq, time: event.time, type: event.type, data }) + '\n', 'utf8');
  } catch (err) {
    log(`cache write failed: ${err?.message ?? err}`);
  }
}

function loadCachedEvents(sid) {
  const out = [];
  try {
    const raw = readFileSync(cacheFile(sid), 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* 半行 */
      }
    }
  } catch {
    /* 无缓存 */
  }
  return out;
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * dsh 用多帧 zstd 追加写，Node 的 zstdDecompressSync 只解第一帧。
 * 按帧 magic 切分逐个解压；遇到压缩体内假 magic 时把该段并回上一帧重解。
 */
function decodeZstdFrames(buf) {
  const starts = [];
  let i = buf.indexOf(ZSTD_MAGIC);
  while (i !== -1) {
    starts.push(i);
    i = buf.indexOf(ZSTD_MAGIC, i + 1);
  }
  if (!starts.length) return '';
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      if (k > 0) {
        try {
          parts[parts.length - 1] = zstdDecompressSync(buf.subarray(starts[k - 1], end));
        } catch {
          /* 真的坏帧 */
        }
      }
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 在 ~/.dsh/sessions/<workspace>/session-<short>/session.v4.jsonl.zstd 里找会话文件。 */
/**
 * 会话 id 解析：接受完整 id 或片段（与 memory_search 的 session 参数行为一致）。
 * 来源：自建缓存目录 + dsh 会话目录；完整等 > 前缀唯一 > 包含唯一 三级匹配。
 */
function resolveSessionId(raw) {
  const key = normSession(raw);
  if (!key) return { id: '', error: '需要 session id' };
  const cands = new Set();
  try {
    for (const f of readdirSync(CACHE_DIR)) {
      if (f.endsWith('.jsonl')) cands.add(f.replace(/\.jsonl$/, ''));
    }
  } catch {
    /* 无缓存目录 */
  }
  try {
    const root = join(HOME, '.dsh', 'sessions');
    for (const ws of readdirSync(root)) {
      try {
        for (const d of readdirSync(join(root, ws))) if (d.startsWith('session-')) cands.add(d);
      } catch {
        /* 跳过不可读工作区 */
      }
    }
  } catch {
    /* 无会话目录 */
  }
  const list = [...cands];
  const short = (c) => c.replace(/^session-/, '').toLowerCase();
  const pick = (arr) => (arr.length === 1 ? arr[0] : null);
  const exact = list.find((c) => short(c) === key);
  if (exact) return { id: exact };
  const byPrefix = list.filter((c) => short(c).startsWith(key));
  if (byPrefix.length === 1) return { id: byPrefix[0] };
  if (byPrefix.length > 1) {
    return { id: '', error: `会话片段 ${raw} 匹配到 ${byPrefix.length} 个会话，请给更长的片段：${byPrefix.slice(0, 5).join(', ')}` };
  }
  const byContains = list.filter((c) => short(c).includes(key));
  if (byContains.length === 1) return { id: byContains[0] };
  if (byContains.length > 1) {
    return { id: '', error: `会话片段 ${raw} 匹配到 ${byContains.length} 个会话，请给更长的片段：${byContains.slice(0, 5).join(', ')}` };
  }
  return { id: '', error: `找不到会话 ${raw}（缓存目录与 dsh 会话目录都没有匹配）` };
}

function findSessionFile(sid) {
  const short = String(sid).replace(/^session-/, '');
  const root = join(HOME, '.dsh', 'sessions');
  try {
    for (const ws of readdirSync(root)) {
      const p = join(root, ws, `session-${short}`, 'session.v4.jsonl.zstd');
      if (existsSync(p)) return p;
    }
  } catch {
    /* 无目录 */
  }
  return null;
}

/** 缓存缺失时从 dsh 会话文件导入；返回导入事件数（0 = 找不到/空）。 */
function importHistory(sid) {
  if (loadCachedEvents(sid).length) return 0;
  const file = findSessionFile(sid);
  if (!file) return 0;
  let text;
  try {
    text = decodeZstdFrames(readFileSync(file));
  } catch (err) {
    log(`import: decode failed ${err?.message ?? err}`);
    return 0;
  }
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const data = scrubEvent(e);
    if (!data || e.seq == null) continue;
    lines.push(JSON.stringify({ seq: e.seq, time: e.time, type: e.type, data }));
  }
  if (!lines.length) return 0;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cacheFile(sid), lines.join('\n') + '\n', 'utf8');
  } catch (err) {
    log(`import: write failed ${err?.message ?? err}`);
    return 0;
  }
  log(`imported history sid=${sid.slice(0, 8)} events=${lines.length} <- ${file}`);
  return lines.length;
}

/**
 * 事件源 = dsh 会话文件（权威全量）∪ 自建缓存（实时增量），按 seq 去重合并。
 * 只读缓存会漏掉「插件启用前」的轮次，对账就看不见它们。
 */
function loadAllEvents(sid) {
  const map = new Map();
  const file = findSessionFile(sid);
  if (file) {
    try {
      const text = decodeZstdFrames(readFileSync(file));
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const data = scrubEvent(e);
        if (!data || e.seq == null) continue;
        map.set(Number(e.seq), { seq: Number(e.seq), time: e.time, type: e.type, data });
      }
    } catch (err) {
      log(`loadAllEvents: file decode failed ${err?.message ?? err}`);
    }
  }
  for (const e of loadCachedEvents(sid)) map.set(Number(e.seq), e);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

/** 已知会话列表：自建缓存 ∪ dsh 自己的会话目录（含插件启用前的旧会话）。 */
function listCachedSessions() {
  const out = new Set();
  try {
    for (const f of readdirSync(CACHE_DIR)) if (f.endsWith('.jsonl')) out.add(f.replace(/\.jsonl$/, ''));
  } catch {
    /* 无缓存目录 */
  }
  try {
    const root = join(HOME, '.dsh', 'sessions');
    for (const ws of readdirSync(root)) {
      let names = [];
      try {
        names = readdirSync(join(root, ws));
      } catch {
        continue;
      }
      for (const name of names) if (name.startsWith('session-')) out.add(name);
    }
  } catch {
    /* 无 dsh 会话目录 */
  }
  return [...out];
}

// ── 观察队列：复刻 pi 的核心机制 ──────────────────────────────
// 1) 共享串行链：所有会话共一条 Promise 链，防并发打爆 vLLM、防乱序写库
// 2) 锚点对账：每条观察记 anchor_seq（轮尾事件 seq）；窗口 = 锚点之后的全部事件
// 3) 失败回退：某轮失败就停在这轮，下轮扫描从同一锚点重试（幂等）
let observeChain = Promise.resolve();
const observeQueued = new Set();

/** 入队（同一会话同一时刻只排一个，避免重复扫描）。 */
function enqueueObserve(sid, reason = '') {
  const key = String(sid || '');
  if (!key || observeQueued.has(key)) return;
  observeQueued.add(key);
  observeChain = observeChain
    .then(async () => {
      observeQueued.delete(key);
      await drainSession(key, reason);
    })
    .catch((err) => {
      observeQueued.delete(key);
      log(`observe chain error: ${err?.message ?? err}`);
    });
}

/** 对账：缓存里的已闭合轮 vs 已记录锚点，差集逐个观察。 */
async function drainSession(sid, reason) {
  const events = loadAllEvents(sid);
  if (!events.length) return;
  let anchors;
  let turns;
  let dismissed;
  try {
    const rows = getDb().prepare('SELECT anchor_seq, turn FROM observations WHERE session_id=?').all(sid);
    anchors = new Set(rows.filter((r) => r.anchor_seq != null).map((r) => Number(r.anchor_seq)));
    // 旧观察没有锚点，用 turn 做辅对账（同一个 turn 不重复观察）
    turns = new Set(rows.filter((r) => r.turn != null).map((r) => Number(r.turn)));
    // 用户主动删掉的轮次：写进墓碑，对账时跳过，不再自动重放
    dismissed = new Set();
    for (const d of getDb().prepare('SELECT anchor_seq, turn FROM dismissed WHERE session_id=?').all(sid)) {
      if (d.anchor_seq != null) dismissed.add(`a:${Number(d.anchor_seq)}`);
      if (d.turn != null) dismissed.add(`t:${Number(d.turn)}`);
    }
  } catch (err) {
    log(`drain: read anchors failed ${err?.message ?? err}`);
    return;
  }

  // 分段：turn/start 起，turn/end 止；未闭合轮留到下次
  const segments = [];
  let cur = null;
  for (const ev of events) {
    if (ev.type === 'turn/start' || cur === null) {
      cur = [];
      segments.push(cur);
    }
    cur.push(ev);
  }
  const pending = segments.filter((seg) => {
    if (!seg.length) return false;
    if (!seg.some((e) => e.type === 'turn/end')) return false;
    const anchor = seg[seg.length - 1].seq;
    if (anchor == null || anchors.has(Number(anchor))) return false;
    const t = seg.find((e) => e.type === 'turn/start')?.data?.turn;
    if (t != null && turns.has(Number(t))) return false; // 旧观察（无锚点）已覆盖该轮
    if (dismissed.has(`a:${Number(anchor)}`)) return false; // 用户删过：不再生成
    if (t != null && dismissed.has(`t:${Number(t)}`)) return false;
    return true;
  });
  if (!pending.length) return;

  log(`drain sid=${sid.slice(0, 8)} pending=${pending.length} (${reason || 'turn/end'})`);
  for (const seg of pending) {
    const ok = await observeSegment(sid, seg);
    if (!ok) {
      log(`observe stopped at anchor=${seg[seg.length - 1]?.seq} (下次对账重试)`);
      break;
    }
  }
}

/** 观察一轮（一段 = 一批，永不切分）。成功落库并记锚点，失败不写 → 下次重试。 */
async function observeSegment(sid, seg) {
  const anchor = seg[seg.length - 1]?.seq;
  const obs = buildObservation(sid, seg);
  obs.anchor_seq = anchor;
  const built = buildPrompt(sid, seg);
  log(
    `prompt sid=${sid.slice(0, 8)} anchor=${anchor} steps=${built.steps} lines=${built.lines} chars=${built.chars} ` +
      `lims=${built.lims.user}/${built.lims.ast}/${built.lims.args}/${built.lims.result}`
  );
  const r = await synthesizeObservation(built.prompt);
  if (r.fields) {
    obs.user_action = r.fields.user_action;
    obs.assistant_action = r.fields.assistant_action;
    obs.note = `用户：${r.fields.user_action}\n助手：${r.fields.assistant_action}`;
    obs.source = `llm:${(LLM.model || 'model').split('/').pop() || 'model'}`;
    log(`llm observation ok in ${r.ms}ms: ${r.fields.user_action.slice(0, 50)}`);
    saveObservation(obs);
    return true;
  }
  obs.source = `${obs.source}-fallback(${r.err})`;
  log(`llm observation failed (${r.err}) after ${r.ms}ms, kept rule note`);
  if (r.err === 'disabled' || r.err === 'no-key' || r.err === 'unconfigured') saveObservation(obs); // 配置问题：存规则版，避免死循环
  return false;
}

/** 周期对账：启动 30s 后扫一次，之后每 10 分钟（删除观察后会在下一次扫描自动补齐）。 */
function startObserveScheduler() {
  const tick = () => {
    const sids = listCachedSessions();
    for (const sid of sids) enqueueObserve(sid, '周期对账');
  };
  const first = setTimeout(tick, 30 * 1000);
  const timer = setInterval(tick, 10 * 60 * 1000);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  log('observe scheduler started (first in 30s, interval 10min)');
}

function broadcast(obs) {
  if (clients.size === 0) return;
  const line = `data: ${JSON.stringify(obs)}\n\n`;
  const obsKey = normSession(obs.session_id);
  for (const [res, filter] of clients) {
    if (filter && filter !== obsKey) continue;
    try {
      res.write(line);
    } catch {
      clients.delete(res);
    }
  }
}

function saveObservation(obs) {
  try {
    const conn = getDb();
    const seg = segment(`${obs.user_action ?? ''}\n${obs.assistant_action ?? ''}`);
    const stmt = conn.prepare(
      'INSERT OR IGNORE INTO observations (session_id, turn, time, user_action, assistant_action, tools, note, source, intent, did, outcome, open_note, keep_note, anchor_seq, segmented_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const info = stmt.run(
      obs.session_id, obs.turn, obs.time, obs.user_action, obs.assistant_action, obs.tools, obs.note, obs.source,
      obs.intent ?? null, obs.did ?? null, obs.outcome ?? null, obs.open_note ?? null, obs.keep_note ?? null,
      obs.anchor_seq ?? null, seg
    );
    if (!info.changes) {
      log(`duplicate anchor skipped session=${obs.session_id.slice(0, 8)} anchor=${obs.anchor_seq}`);
      return;
    }
    const newId = Number(stmt.lastInsertRowid ?? 0);
    appendFileSync(JSONL_PATH, JSON.stringify(obs) + '\n', 'utf8');
    log(`saved turn=${obs.turn} session=${obs.session_id} note=${obs.note.slice(0, 100)}`);
    broadcast({ ...obs, id: newId });
    // 向量异步补（不阻塞观察落盘；失败时下次兜底扫描会重试）
    void backfillEmbedding(newId);
  } catch (err) {
    log(`save failed: ${err?.message ?? err}`);
  }
}

/** 给单条观察补向量（幂等：已有 embedding 直接跳过）。 */
async function backfillEmbedding(id) {
  if (!EMB.enabled || !id) return false;
  try {
    const conn = getDb();
    const row = conn
      .prepare('SELECT id, user_action, assistant_action, embedding FROM observations WHERE id = ?')
      .get(id);
    if (!row || row.embedding) return false;
    const vec = await embedText(`${row.user_action ?? ''}\n${row.assistant_action ?? ''}`.slice(0, 6000));
    if (!vec) {
      log(`embed failed id=${id} (${EMB.url} unreachable?)`);
      return false;
    }
    conn.prepare('UPDATE observations SET embedding = ?, embedding_model = ? WHERE id = ?').run(vecToBlob(vec), EMB.model, id);
    return true;
  } catch (err) {
    log(`backfillEmbedding failed id=${id}: ${err?.message ?? err}`);
    return false;
  }
}

/** 存量补齐：先补分词（快、同步），再分批补向量（慢、逐条）。 */
let backfillBusy = false;
async function backfillWorker(limit = 200) {
  if (backfillBusy) return;
  backfillBusy = true;
  try {
    const conn = getDb();
    const segRows = conn
      .prepare("SELECT id, user_action, assistant_action FROM observations WHERE segmented_text IS NULL OR segmented_text = '' LIMIT ?")
      .all(limit);
    let segFixed = 0;
    for (const r of segRows) {
      try {
        conn
          .prepare('UPDATE observations SET segmented_text = ? WHERE id = ?')
          .run(segment(`${r.user_action ?? ''}\n${r.assistant_action ?? ''}`), r.id);
        segFixed += 1;
      } catch {
        /* 单条失败跳过 */
      }
    }
    const embRows = conn.prepare('SELECT id FROM observations WHERE embedding IS NULL LIMIT ?').all(40);
    let embFixed = 0;
    for (const r of embRows) {
      if (await backfillEmbedding(r.id)) embFixed += 1;
    }
    if (segFixed || embFixed) log(`backfill: segmented +${segFixed}, embedding +${embFixed}`);
  } catch (err) {
    log(`backfillWorker failed: ${err?.message ?? err}`);
  }
  backfillBusy = false;
}

/** 会话 id 归一：观察里存的是 `session-<uuid>`，槽位给的可能不带前缀。 */
function normSession(value) {
  return String(value ?? '')
    .trim()
    .replace(/^session-/i, '')
    .toLowerCase();
}

function readRecent(limit) {
  try {
    const conn = getDb();
    return conn.prepare('SELECT * FROM observations ORDER BY time DESC, id DESC LIMIT ?').all(limit);
  } catch (err) {
    log(`read failed: ${err?.message ?? err}`);
    return [];
  }
}

/** 按会话取观察（session 为空 = 全库）。 */
function readBySession(session, limit) {
  const key = normSession(session);
  if (!key) return readRecent(limit);
  try {
    const conn = getDb();
    const rows = conn.prepare(
      "SELECT * FROM observations WHERE lower(replace(session_id, 'session-', '')) = ? ORDER BY COALESCE(turn, 0) DESC, time DESC LIMIT ?"
    ).all(key, limit);
    return rows;
  } catch (err) {
    log(`readBySession failed: ${err?.message ?? err}`);
    return [];
  }
}

function sendJson(res, body) {
  const text = JSON.stringify(body);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

/** 读 JSON 请求体（1MB 上限）。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** 手工编辑一条观察（正文 + note 同步，source 标为 user-edit 便于区分）。 */
function updateObservation(id, userAction, assistantAction) {
  const user = String(userAction ?? '').trim();
  const ast = String(assistantAction ?? '').trim();
  if (!user && !ast) return { ok: false, err: '内容不能为空' };
  const note = `用户：${user}\n助手：${ast}`;
  const r = getDb()
    .prepare('UPDATE observations SET user_action=?, assistant_action=?, note=?, source=?, segmented_text=?, embedding=NULL WHERE id=?')
    .run(user, ast, note, 'user-edit', segment(`${user}\n${ast}`), id);
  if (r.changes) void backfillEmbedding(id); // 手改后重算向量，否则语义检索仍按旧内容走
  return r.changes ? { ok: true, id } : { ok: false, err: '未找到该记录' };
}

/** 删除一条观察（只删库，不追溯已生成的总结）。 */
function deleteObservation(id, mode = 'delete') {
  const conn = getDb();
  const row = conn.prepare('SELECT session_id, anchor_seq, turn FROM observations WHERE id=?').get(id);
  const r = conn.prepare('DELETE FROM observations WHERE id=?').run(id);
  if (!r.changes) return { ok: false, err: '未找到该记录' };
  const sid = row && row.session_id ? String(row.session_id) : '';
  if (!sid) return { ok: true, id, mode };
  const anchor = row.anchor_seq != null ? Number(row.anchor_seq) : null;
  const turn = row.turn != null ? Number(row.turn) : null;

  if (mode === 'regen') {
    // 重新生成：清墓碑 + 立即入队重放
    conn
      .prepare(
        'DELETE FROM dismissed WHERE session_id=? AND ((anchor_seq IS NOT NULL AND anchor_seq=?) OR (turn IS NOT NULL AND turn=?))'
      )
      .run(sid, anchor ?? -1, turn ?? -1);
    enqueueObserve(sid, '重新生成');
    return { ok: true, id, mode };
  }

  if (mode === 'ignore') {
    // 忽略：写墓碑，永远不再为这一轮生成观察
    conn
      .prepare('INSERT INTO dismissed (session_id, anchor_seq, turn, created_at) VALUES (?,?,?,?)')
      .run(sid, anchor, turn, new Date().toISOString());
    return { ok: true, id, mode };
  }

  // 删除（默认）：只删记录，不写墓碑、不立即重放；
  // 下一轮对话或周期对账时会被当成「缺观察的轮次」补齐
  return { ok: true, id, mode };
}

/** 读被忽略的轮次（session 为空 = 全库）。 */
function readDismissed(session, limit = 300) {
  const key = normSession(session);
  try {
    const conn = getDb();
    if (key) {
      return conn
        .prepare(
          "SELECT * FROM dismissed WHERE lower(replace(session_id, 'session-', '')) = ? ORDER BY turn DESC LIMIT ?"
        )
        .all(key, limit);
    }
    return conn.prepare('SELECT * FROM dismissed ORDER BY turn DESC LIMIT ?').all(limit);
  } catch (err) {
    log(`readDismissed failed: ${err?.message ?? err}`);
    return [];
  }
}

/** 取消忽略：删墓碑并立即重新入队（这一轮会重新观察）。 */
function undismiss(sessionId, turn, anchorSeq) {
  const sid = String(sessionId || '');
  if (!sid) return { ok: false, err: '缺少 session_id' };
  try {
    const conn = getDb();
    const r = conn
      .prepare(
        "DELETE FROM dismissed WHERE lower(replace(session_id, 'session-', '')) = ? AND ((turn IS NOT NULL AND turn = ?) OR (anchor_seq IS NOT NULL AND anchor_seq = ?))"
      )
      .run(normSession(sid), turn ?? -1, anchorSeq ?? -1);
    if (r.changes) enqueueObserve(sid, '取消忽略');
    log(`undismiss sid=${sid.slice(0, 8)} turn=${turn} changed=${r.changes}`);
    return { ok: true, changed: r.changes };
  } catch (err) {
    return { ok: false, err: err?.message ?? String(err) };
  }
}

/** 仅在存在 webServer 服务时注册 HTTP 路由（headless 没有 HTTP 层）。 */
function registerRoutes(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = [];

      disposers.push(
        webCtx.webServer.register({
          kind: 'exact',
          path: PAGE_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405);
              res.end();
              return;
            }
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(
              req.method === 'HEAD'
                ? undefined
                : panelHtml({
                    pagePath: PAGE_PATH,
                    jsonPath: JSON_PATH,
                    streamPath: STREAM_PATH,
                    summariesPath: SUMMARIES_PATH,
                    updatePath: UPDATE_PATH,
                    deletePath: DELETE_PATH,
                    dismissedPath: DISMISSED_PATH,
                    undismissPath: UNDISMISS_PATH,
                  })
            );
          },
        })
      );

      disposers.push(
        webCtx.webServer.register({
          kind: 'exact',
          path: JSON_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405);
              res.end();
              return;
            }
            const params = new URL(req.url, 'http://x').searchParams;
            const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 500);
            const session = params.get('session') || '';
            sendJson(res, readBySession(session, limit));
          },
        })
      );

      disposers.push(
        webCtx.webServer.register({
          kind: 'exact',
          path: STREAM_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET') {
              res.writeHead(405);
              res.end();
              return;
            }
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            });
            res.write(': connected\n\n');
            const filter = normSession(new URL(req.url, 'http://x').searchParams.get('session') || '');
            clients.set(res, filter || null);
            log(`sse client attached, session=${filter || '(all)'}, total=${clients.size}`);
            req.on('close', () => clients.delete(res));
            res.on('close', () => clients.delete(res));
          },
        })
      );

      disposers.push(
        webCtx.webServer.register({
          kind: 'exact',
          path: SUMMARIES_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405);
              res.end();
              return;
            }
            const params = new URL(req.url, 'http://x').searchParams;
            const limit = Math.min(Math.max(Number(params.get('limit')) || 30, 1), 200);
            const kind = params.get('kind') || '';
            sendJson(res, readSummaries(kind, limit));
          },
        })
      );

      disposers.push(
        webCtx.webServer.register({
          kind: 'exact',
          path: UPDATE_PATH,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405);
              res.end();
              return;
            }
            const body = await readJsonBody(req);
            const id = Number(body.id);
            if (!Number.isInteger(id) || id <= 0) {
              sendJson(res, { ok: false, err: 'id 不合法' });
              return;
            }
            const r = updateObservation(id, body.user_action, body.assistant_action);
            log(`observation update id=${id}: ${r.ok ? 'ok' : r.err}`);
            sendJson(res, r);
          },
        })
      );

      disposers.push(
        webCtx.webServer.register({
          kind: 'exact',
          path: DELETE_PATH,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405);
              res.end();
              return;
            }
            const body = await readJsonBody(req);
            const id = Number(body.id);
            if (!Number.isInteger(id) || id <= 0) {
              sendJson(res, { ok: false, err: 'id 不合法' });
              return;
            }
            const mode = body.mode || (body.replay ? 'regen' : 'delete');
            const r = deleteObservation(id, mode);
            log(`observation delete id=${id} mode=${mode}: ${r.ok ? 'ok' : r.err}`);
            sendJson(res, r);
          },
        })
      );

      disposers.push(
        webCtx.webServer.register({
          kind: 'exact',
          path: DISMISSED_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405);
              res.end();
              return;
            }
            const params = new URL(req.url, 'http://x').searchParams;
            sendJson(res, readDismissed(params.get('session') || ''));
          },
        })
      );

      disposers.push(
        webCtx.webServer.register({
          kind: 'exact',
          path: UNDISMISS_PATH,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              res.writeHead(405);
              res.end();
              return;
            }
            const body = await readJsonBody(req);
            const turn = body.turn == null ? null : Number(body.turn);
            const anchor = body.anchor_seq == null ? null : Number(body.anchor_seq);
            sendJson(res, undismiss(body.session_id, turn, anchor));
          },
        })
      );

      log(`web routes registered: ${PAGE_PATH} ${JSON_PATH} ${STREAM_PATH} ${SUMMARIES_PATH} ${DISMISSED_PATH}`);

      return () => {
        for (const d of disposers) {
          try {
            d();
          } catch {
            /* ignore */
          }
        }
        for (const r of clients.keys()) {
          try {
            r.destroy();
          } catch {
            /* ignore */
          }
        }
        clients.clear();
      };
    }, 'memory-probe: http routes');
  });
}

export function apply(ctx) {
  ensureDir();
  log(`plugin loaded, dir=${DIR}`);

  // 1) 观察：所有事件进缓存（重放源），turn/end 只负责入队——真正的观察由共享链 + 锚点对账完成
  ctx.on('session/event', (session, event) => {
    try {
      const sid = String(session?.id ?? 'unknown');
      cacheEvent(sid, event);
      if (event?.type === 'turn/end') enqueueObserve(sid, 'turn/end');
    } catch (err) {
      log(`session/event handler error: ${err?.message ?? err}`);
    }
  });

  // 1b) 周期对账：扫到未记录的闭合轮就补（删了观察也会在这里自动重放）
  try {
    startObserveScheduler();
  } catch (err) {
    log(`observe scheduler start failed: ${err?.message ?? err}`);
  }

  // 2) 面板路由（仅 web profile 有 webServer）
  registerRoutes(ctx);

  // 3) 日/周/月总结调度（定时扫缺漏；失败不阻塞，下轮重试）
  try {
    startSummaryScheduler();
  } catch (err) {
    log(`summary scheduler start failed: ${err?.message ?? err}`);
  }

  // 3b) 检索索引补齐调度：启动 20s 后补一批，之后每 5 分钟扫一次缺失的分词/向量
  try {
    startBackfillScheduler();
  } catch (err) {
    log(`backfill scheduler start failed: ${err?.message ?? err}`);
  }

  // 4) 唤醒：注册读回观察的工具
  try {
    const wakeTool = defineTool({
      name: 'memory_wake',
      description:
        'Read the layered long-term memory: current time anchor, recent daily/weekly/monthly summaries, and observation-log counts. Use it at the start of a conversation or when the user asks what happened before.',
      parameters: {
        recent: { type: 'number', description: 'How many recent observations to append. Default 0 (summaries only).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            count: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args) => {
        let text = buildWakeText();
        const n = Math.min(Math.max(Number(args?.recent) || 0, 0), 30);
        if (n > 0) {
          const rows = readRecent(n);
          if (rows.length) {
            text += '\n【最近观察】\n' + rows.map((r) => `- turn=${r.turn} 用户：${r.user_action}｜助手：${r.assistant_action}`).join('\n');
          }
        }
        log('memory_wake called');
        return { text, count: n };
      },
    });
    ctx.tools.register(wakeTool);
    log('tool memory_wake registered');

    // 检索工具：观察日志是长期记忆的主体，按关键词/会话检索
    const searchTool = defineTool({
      name: 'memory_search',
      description:
        'Search the observation log. Supports multi-keyword OR (space/comma separated, quote a phrase to keep it whole), time range, session fragment, and two output modes: list (turns, newest first) or sessions (hit counts grouped by session, to find which session covered a topic). Omit query and give since/until to browse a time range in full.',
      parameters: {
        query: { type: 'string', description: 'Keywords, OR-joined. "quoted phrase" stays whole. Optional.' },
        session: { type: 'string', description: 'Session id or a fragment of it (e.g. 81fdca). Optional.' },
        since: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive). Optional.' },
        until: { type: 'string', description: 'End date YYYY-MM-DD (inclusive). Optional.' },
        mode: { type: 'string', description: "list (default) | sessions (grouped hit counts) | semantic (vector only, ignores literal match)." },
        limit: { type: 'number', description: 'Max rows. Default 20, max 200.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            count: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 200);
        const rawMode = String(args?.mode || 'list').toLowerCase();
        const mode = rawMode === 'sessions' ? 'sessions' : rawMode === 'semantic' ? 'semantic' : 'list';
        const stamp = (t) => new Date(Number(t) + TZ_MS).toISOString().slice(0, 19).replace('T', ' ');
        const rows = await searchObservations({
          query: args?.query,
          session: args?.session,
          since: args?.since,
          until: args?.until,
          limit,
          groupBySession: mode === 'sessions',
          semanticOnly: mode === 'semantic',
        });

        let text;
        if (!rows.length) {
          text = '没有匹配的观察记录（可放宽关键词、去掉日期限制，或用 memory_sessions 先看有哪些会话）';
        } else if (mode === 'sessions') {
          text =
            '按会话聚合（命中数降序）：\n' +
            rows
              .map(
                (r) =>
                  `- ${r.session_id} · 命中 ${r.hits} 条 · turn ${r.min_turn}~${r.max_turn} · ${stamp(r.first_time)} ~ ${stamp(r.last_time)}`
              )
              .join('\n');
        } else {
          text = rows
            .map(
              (r) =>
                `- [${stamp(r.time)}] ${normSession(r.session_id).slice(0, 8)} turn=${r.turn} 用户：${r.user_action}｜助手：${r.assistant_action}`
            )
            .join('\n');
          // 没有字面命中时明说，避免把「语义最像的几条」误读成「命中了」
          // 弱命中判定：完全没有字面命中，或多词查询只命中 1~2 条（多半是碰巧含某个词）
          const weak = !rows.ftsHits || (rows.ftsHits <= 2 && Number(rows.terms || 0) >= 3);
          if (weak && mode !== 'semantic') {
            const why = rows.ftsHits ? `只有 ${rows.ftsHits} 条字面命中（查询词 ${rows.terms} 个）` : '没有字面命中';
            text =
              `⚠️ 关键词${why}，以下 ${rows.length} 条多为语义近似结果（最高相似度 ${Number(rows.topSim || 0).toFixed(2)}），可能与本意无关：\n` +
              text;
          }
        }
        log(`memory_search q=${args?.query || ''} mode=${mode} hits=${rows.length} fts=${rows.ftsHits ?? '-'}`);
        return { text, count: rows.length };
      },
    });
    ctx.tools.register(searchTool);
    log('tool memory_search registered');

    const toolOut = {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          count: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    };
    const stamp = (t) => new Date(Number(t) + TZ_MS).toISOString().slice(0, 19).replace('T', ' ');

    // 会话清单
    const sessionsTool = defineTool({
      name: 'memory_sessions',
      description:
        'List sessions that have memory observations, newest first: session id, observation count, turn range and time span. Use it to locate which session covered a topic before calling memory_search.',
      parameters: { limit: { type: 'number', description: 'Max sessions. Default 20, max 100.' } },
      output: toolOut,
      execute: async (args) => {
        const rows = listSessions(Math.min(Math.max(Number(args?.limit) || 20, 1), 100));
        const text = rows.length
          ? rows
              .map(
                (r) =>
                  `- ${r.session_id} · ${r.n} 条 · turn ${r.min_turn}~${r.max_turn} · ${stamp(r.first_time)} ~ ${stamp(r.last_time)}`
              )
              .join('\n')
          : '（还没有任何会话的观察记录）';
        return { text, count: rows.length };
      },
    });
    ctx.tools.register(sessionsTool);

    // 补观察（对齐 pi /observe）
    const observeTool = defineTool({
      name: 'memory_observe',
      description:
        'Reconcile observations for a session: find closed turns without an observation and generate them in the background (same mechanism as the automatic scheduler). Use it after manually deleting observations or when a session is missing records.',
      parameters: {
        session: { type: 'string', description: 'Session id, with or without the session- prefix.', required: true },
      },
      output: toolOut,
      execute: async (args) => {
        const raw = String(args?.session || '').trim();
        if (!raw) return { text: '需要 session id（完整 id 或片段均可）', count: 0 };
        const resolved = resolveSessionId(raw);
        if (!resolved.id) return { text: resolved.error, count: 0 };
        const sid = resolved.id;
        const events = loadAllEvents(sid);
        if (!events.length) return { text: `会话 ${sid} 存在但没有可读事件（dsh 文件与缓存都为空）`, count: 0 };
        const turns = events.filter((e) => e.type === 'turn/end').length;
        enqueueObserve(sid, 'memory_observe');
        log(`memory_observe sid=${sid.replace(/^session-/, '').slice(0, 8)} turns=${turns}`);
        return { text: `已入队补齐：${sid}（共 ${turns} 个已闭合轮次），完成后在记忆面板查看`, count: turns };
      },
    });
    ctx.tools.register(observeTool);

    // 生成总结（对齐 pi /summarize）
    const summarizeTool = defineTool({
      name: 'memory_summarize',
      description:
        'Generate or regenerate a summary: daily (period YYYY-MM-DD), weekly (period = Monday YYYY-MM-DD) or monthly (period YYYY-MM). Daily aggregates that day observations; weekly/monthly aggregate daily summaries.',
      parameters: {
        kind: { type: 'string', description: 'daily | weekly | monthly', required: true },
        period: { type: 'string', description: 'daily/weekly: YYYY-MM-DD (weekly uses that week Monday); monthly: YYYY-MM', required: true },
      },
      output: toolOut,
      execute: async (args) => {
        const kind = String(args?.kind || '').trim();
        const period = String(args?.period || '').trim();
        if (!['daily', 'weekly', 'monthly'].includes(kind)) return { text: 'kind 必须是 daily/weekly/monthly', count: 0 };
        if (!/^\d{4}-\d{2}(-\d{2})?$/.test(period)) return { text: 'period 格式：YYYY-MM-DD 或 YYYY-MM', count: 0 };
        const p = kind === 'weekly' ? mondayOf(period) : period;
        const r = await runSummary(kind, p);
        log(`memory_summarize ${kind} ${p}: ${r.ok ? 'ok' : r.err}`);
        return {
          text: r.ok ? `已生成 ${kind} 总结 ${p}（${r.stats}）` : `生成失败：${r.err}`,
          count: r.ok ? 1 : 0,
        };
      },
    });
    ctx.tools.register(summarizeTool);
    log('tools memory_sessions / memory_observe / memory_summarize registered');
  } catch (err) {
    log(`tool registration failed: ${err?.message ?? err}`);
  }
}

// 调试/迁移用导出（不影响插件行为）
export { importHistory, loadCachedEvents, loadAllEvents, drainSession, decodeZstdFrames, buildWakeText, searchObservations, listSessions, backfillWorker, segment, collectPendingSummaries, resolveSessionId };
