/**
 * 配置解析：环境变量 > local.config.json > 内置默认值。
 *
 * 查找顺序：
 *   $DSH_MEMORY_CONFIG
 *   → <包目录>/local.config.json
 *   → <运行时目录>/local.config.json（~/.dsh/memory-probe）
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, delimiter as PATH_DELIMITER } from 'node:path';

export const CONFIG_FILENAME = 'local.config.json';

/** 内置默认值。 */
export const DEFAULTS = Object.freeze({
  llm: {
    enabled: true,
    baseUrl: '', // OpenAI 兼容端点
    model: '', // 模型名
    keyEnv: '', // 密钥所在的环境变量名
    secretsFile: '', // 可选的 KEY=VALUE 文本文件路径
    timeoutMs: 120000,
  },
  embed: {
    enabled: true,
    url: '', // embedding 端点
    model: '', // embedding 模型名
    timeoutMs: 20000,
  },
  search: {
    minSim: 0.2,
  },
  jieba: {
    modulePaths: [], // 额外的 @node-rs/jieba 候选路径
  },
});

function filled(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function pickEnv(env, name) {
  const v = env?.[name];
  return filled(v) ? v.trim() : undefined;
}

function asString(v, fallback) {
  return filled(v) ? v.trim() : fallback;
}

function asNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function asBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  return !/^(off|false|0|no|disabled)$/i.test(String(v).trim());
}

/**
 * 读取并解析一个配置文件。
 * @returns {{ok: true, path: string, data: object} | {ok: false, path: string, reason: string, error?: string}}
 */
export function readConfigFile(file) {
  if (!filled(file) || !existsSync(file)) return { ok: false, path: file || '', reason: 'missing' };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, path: file, reason: 'unreadable', error: String(err?.message ?? err) };
  }
  try {
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, path: file, reason: 'not-an-object' };
    }
    return { ok: true, path: file, data };
  } catch (err) {
    return { ok: false, path: file, reason: 'parse-error', error: String(err?.message ?? err) };
  }
}

/**
 * 解析最终配置。纯函数（除读文件外无副作用），便于单测。
 * @param {{env?: object, dirs?: string[]}} opts
 */
export function loadConfig({ env = process.env, dirs = [] } = {}) {
  const errors = [];
  const explicit = pickEnv(env, 'DSH_MEMORY_CONFIG');
  const candidates = explicit ? [explicit] : dirs.filter(filled).map((d) => join(d, CONFIG_FILENAME));

  let file = { ok: false, path: '', reason: 'missing' };
  for (const candidate of candidates) {
    const result = readConfigFile(candidate);
    if (result.ok) {
      file = result;
      break;
    }
    if (result.reason !== 'missing') {
      errors.push(`${result.path}: ${result.reason}${result.error ? ` (${result.error})` : ''}`);
    }
  }

  const fc = file.ok ? file.data : {};
  const fcLlm = fc.llm && typeof fc.llm === 'object' ? fc.llm : {};
  const fcEmbed = fc.embed && typeof fc.embed === 'object' ? fc.embed : {};
  const fcSearch = fc.search && typeof fc.search === 'object' ? fc.search : {};
  const fcJieba = fc.jieba && typeof fc.jieba === 'object' ? fc.jieba : {};

  const envJieba = pickEnv(env, 'DSH_MEMORY_JIEBA_PATHS');
  const extraJieba = envJieba
    ? envJieba.split(PATH_DELIMITER).map((s) => s.trim()).filter(Boolean)
    : (Array.isArray(fcJieba.modulePaths) ? fcJieba.modulePaths : []).filter(filled).map((s) => String(s).trim());

  const llm = {
    enabled: asBool(pickEnv(env, 'DSH_MEMORY_LLM') ?? fcLlm.enabled, DEFAULTS.llm.enabled),
    baseUrl: asString(pickEnv(env, 'DSH_MEMORY_LLM_BASE') ?? fcLlm.baseUrl, DEFAULTS.llm.baseUrl),
    model: asString(pickEnv(env, 'DSH_MEMORY_LLM_MODEL') ?? fcLlm.model, DEFAULTS.llm.model),
    keyEnv: asString(pickEnv(env, 'DSH_MEMORY_LLM_KEY_ENV') ?? fcLlm.keyEnv, DEFAULTS.llm.keyEnv),
    secretsFile: asString(pickEnv(env, 'DSH_MEMORY_LLM_SECRETS') ?? fcLlm.secretsFile, DEFAULTS.llm.secretsFile),
    timeoutMs: asNumber(pickEnv(env, 'DSH_MEMORY_LLM_TIMEOUT_MS') ?? fcLlm.timeoutMs, DEFAULTS.llm.timeoutMs),
    configured: false,
  };
  // 端点或模型缺失时不发请求，走规则摘要
  llm.configured = Boolean(llm.baseUrl && llm.model);
  if (llm.enabled && !llm.configured) llm.enabled = false;

  const embed = {
    enabled: asBool(pickEnv(env, 'DSH_MEMORY_EMBED') ?? fcEmbed.enabled, DEFAULTS.embed.enabled),
    url: asString(pickEnv(env, 'DSH_MEMORY_EMBED_URL') ?? fcEmbed.url, DEFAULTS.embed.url),
    model: asString(pickEnv(env, 'DSH_MEMORY_EMBED_MODEL') ?? fcEmbed.model, DEFAULTS.embed.model),
    timeoutMs: asNumber(pickEnv(env, 'DSH_MEMORY_EMBED_TIMEOUT_MS') ?? fcEmbed.timeoutMs, DEFAULTS.embed.timeoutMs),
  };
  if (!embed.url) embed.enabled = false;

  const search = {
    minSim: asNumber(pickEnv(env, 'DSH_MEMORY_MIN_SIM') ?? fcSearch.minSim, DEFAULTS.search.minSim),
  };

  return {
    llm,
    embed,
    search,
    jieba: { modulePaths: extraJieba },
    sources: {
      file: file.ok ? file.path : '',
      searched: candidates,
      errors,
    },
  };
}

/** 启动日志摘要：路径与开关。 */
export function describeConfig(config) {
  const { llm, embed, sources } = config;
  const parts = [
    `file=${sources.file || '(none)'}`,
    `llm=${llm.enabled ? 'on' : 'off'}`,
    `embed=${embed.enabled ? 'on' : 'off'}`,
    `minSim=${config.search.minSim}`,
  ];
  if (sources.errors.length) parts.push(`errors=${sources.errors.length}`);
  return parts.join(' ');
}

export default loadConfig;
