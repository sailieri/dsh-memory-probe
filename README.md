# dsh-memory-probe

给 [dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) 用的长期记忆插件：每轮对话结束时自动生成一条「观察」写入本地 SQLite，并提供工具检索、唤醒、日/周/月总结，以及 Web 面板里的「记忆」标签页。

## 能力

| 组成 | 说明 |
|---|---|
| 自动观察 | 监听 `turn/end`，把该轮的用户意图 + 助手动作 + 工具调用压缩成一条观察（配置了 LLM 就用 LLM，否则退化为规则摘要） |
| 工具 | `memory_wake`（分层唤醒）、`memory_search`（关键词/语义/时间范围/会话过滤/按会话聚合）、`memory_sessions`、`memory_observe`（补齐）、`memory_summarize`（日/周/月） |
| 面板 | `/memory-probe/` 观察日志页 + `/memory-probe/observations.json`、`summaries.json`、`stream`（SSE） |
| 存储 | `~/.dsh/memory-probe/memory.db`（观察、总结、墓碑、跳过表） |

## 安装

作为 bundle 安装（推荐，会同时写入 profile 的 bundle 层）：

```bash
# npm
plugin_manager install_bundle target="dsh-memory-probe"

# 或直接从 GitHub
plugin_manager install_bundle target="git+https://github.com/sailieri/dsh-memory-probe.git"
```

手动安装（不经 bundle 机制）：

```bash
# 1) 加依赖
pnpm add -C ~/.dsh/profiles/web dsh-memory-probe

# 2) 在 profile 的 cordis.patch.yml 里插入一行
- insert:
    - id: memory-probe
      name: dsh-memory-probe
```

## 数据与权限

装之前请知悉它的边界：

- 插件运行在 dsh 的 Host 进程内，**拥有与该进程相同的文件系统权限**。
- 会写入 `~/.dsh/memory-probe/`（`memory.db`、`observations.jsonl`、`probe.log`、`sessions/` 事件缓存），也会读取 `~/.dsh/sessions/` 下的会话文件以补齐历史轮次。
- 观察记录默认包含用户与助手的对话摘要，属于敏感数据；分享数据目录前请自行清理。
- 配置了 `llm.baseUrl` 时，会把当轮的对话摘要发送到该端点；未配置则只做本地规则摘要，不发任何请求。
- 不收集遥测，不访问除配置端点以外的网络。

## 配置

所有机器相关的值都从配置文件读取：

查找顺序：

1. `$DSH_MEMORY_CONFIG`（显式路径）
2. `<包目录>/local.config.json`（开发期覆盖）
3. `~/.dsh/memory-probe/local.config.json`（推荐：运行时目录，天然不进包）

从 `local.config.example.json` 复制一份改名 `local.config.json` 再填：

| 字段 | 作用 |
|---|---|
| `llm.baseUrl` / `llm.model` | OpenAI 兼容的 `/chat/completions` 端点与模型名；**留空则观察退化为规则摘要** |
| `llm.keyEnv` | 存放密钥的**环境变量名**（留空则只从 `secretsFile` 读取） |
| `llm.secretsFile` | 可选：`KEY=VALUE` 文本文件，按 `keyEnv` 取其一 |
| `embed.url` / `embed.model` | embedding 端点（兼容 `data[0].embedding` 与 `embeddings[0]` 两种响应）；留空则语义检索退化为纯关键词 |
| `search.minSim` | 语义召回保底相似度（默认 0.2；无关查询的 top 相似度因模型而异，可自行调高） |
| `jieba.modulePaths` | 额外的 `@node-rs/jieba` 候选路径（一般留空，默认从 `dependencies` 解析） |

环境变量（优先级高于配置文件）：`DSH_MEMORY_LLM`、`DSH_MEMORY_LLM_BASE`、`DSH_MEMORY_LLM_MODEL`、`DSH_MEMORY_LLM_KEY_ENV`、`DSH_MEMORY_LLM_SECRETS`、`DSH_MEMORY_LLM_TIMEOUT_MS`、`DSH_MEMORY_EMBED`、`DSH_MEMORY_EMBED_URL`、`DSH_MEMORY_EMBED_MODEL`、`DSH_MEMORY_EMBED_TIMEOUT_MS`、`DSH_MEMORY_MIN_SIM`、`DSH_MEMORY_JIEBA_PATHS`（`;` 分隔）。

## 依赖

- dsh `^0.2.0`（见 `engines.dsh`）
- Node 版本由 dsh 决定；插件本身使用 `node:sqlite` 与 `node:zstd`，需要 Node ≥ 22.5
- `@node-rs/jieba`（随包依赖，用于中文分词 + FTS5）
- 可选：embedding 服务（`data[0].embedding` 与 `embeddings[0]` 两种响应均支持）、任意 OpenAI 兼容推理服务（观察生成）

## 开发

```bash
node test-config.mjs      # 配置解析的离线单测
node test-harness.mjs     # 模拟一轮会话事件，触发真实的观察生成（需要已配置 LLM）
```

## 打包

`files` 限定为 `lib/*.js`、`cordis.patch.yml`、`local.config.example.json`、`locale/*.json`、`icon.svg`、`README.md`、`LICENSE`；`local.config.json` 不进包。

```bash
npm pack --dry-run     # 确认文件清单
```

## License

MIT
