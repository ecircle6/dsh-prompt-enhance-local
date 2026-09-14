# dsh-prompt-enhance

[![Download](https://img.shields.io/badge/Download-latest-2e7d32?style=flat&logo=github&logoColor=white)](https://github.com/zzy6-a/dsh-prompt-enhance/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2f6fed)](https://github.com/topics/dsh-plugin)

**Composer 里的一键提示词增强**：写完一句话，点一下 ✨，它把你的说法改写成一条目标明确、细节完整的任务说明，再交回输入框——可一键撤销。

写给 AI 编程助手（agent）的提示词，往往差在"没说清"：想改哪里、不要改哪里、产出什么、怎么算做完。这个插件把这一步变成输入框旁边的一次点击，用的是**你自己正在用的模型**，不额外配置任何东西。

## 功能

| | |
|---|---|
| ✨ **一键增强** | 读取当前草稿 → 补全目标 / 范围 / 产出 / 约束 / 验收 → 整稿替换 |
| ↩ **一键撤销** | 草稿没被手动改动前，撤销按钮一直在，点一下恢复原文 |
| 🎛 **五种改写风格** | 补全细节（默认）· 更简洁 · 更详细 · 加约束 · 结构化 |
| 🧭 **模型可跟随可固定** | 默认跟随当前会话的模型；也可固定一个便宜的模型专跑改写 |
| 🧩 **芯片保护** | 草稿含 `@文件引用`、`/命令`、skill 芯片时按钮置灰并说明原因（整稿替换会切断这些引用） |
| 🪄 **空草稿两种策略** | 置灰，或「按最近对话生成一条提示词」 |
| 🌏 **中英双语** | 界面文案跟随 DSH 语言 |

## 使用

1. 在输入框写下你的想法（一句口语也可以），比如 `把日志页的时间筛选换成下拉`；
2. 点模型选择器左边的 **✨**；
3. 按钮变成 `···`，完成后草稿被替换为改写后的提示词；
4. 不满意就点旁边的 **↩** 撤销，恢复原文。

> 草稿里如果有 `@` 文件引用、`/` 命令或 skill 芯片，✨ 会置灰——这是**故意的**：整稿替换会把结构化引用降级成纯文本，宁可先拦下。

## 设置

设置 → 左侧 **提示词增强**（本插件自己的分区，不占用其它插件的卡片位）。

| 设置项 | 选项 | 默认 |
|---|---|---|
| 启用提示词增强按钮 | 开 / 关 | 开 |
| 改写风格 | 补全细节、明确目标 / 更简洁 / 更详细 / 加约束 / 结构化 | 补全细节、明确目标 |
| 模型 | 跟随当前会话 / 固定 provider + model | 跟随当前会话 |
| 空草稿时 | 禁用按钮 / 按最近对话生成一条提示词 | 禁用按钮 |
| 自定义提示词模板 | 留空 = 用所选风格的内置 system 提示词；填写后完全覆盖 | 空 |

配置存在宿主设置命名空间 `prompt-enhance`，改完立即生效（无需重启）。

## 工作原理

```
composer 草稿 ──POST /api/dsh-prompt-enhance/enhance──▶ host 半区
                                                          │
                        system = 内置风格模板 / 自定义模板 ◀┘
                                                          │
                                          ctx.llm.stream（一次性调用）
                                                          │
       改写后的提示词 ◀──────── JSON ─────────────────────┘
              │
   inputActions.setDraft(text)  ← 整稿替换（可撤销）
```

- **一次性模型调用**：`hand-built` 请求，不写进会话日志、不进 agent 上下文，所以不会污染对话、也不会影响后续请求的前缀缓存；
- **模型路由优先级**：设置里固定 → 会话最近一次主模型调用（从 `llm/stream` 水位捕获，排除辅助调用）→ 宿主默认模型；
- **服务端只做三件事**：拼接 system 提示词、调用模型、剥掉多余代码围栏（模型偶尔会加）；不保存任何草稿。

### HTTP API

`POST /api/dsh-prompt-enhance/enhance`

```jsonc
// 请求
{ "sessionId": "session-…", "draft": "把日志页的时间筛选换成下拉" }

// 成功
{ "ok": true, "text": "把日志页的时间筛选控件…", "route": { "provider": "opencode-go", "model": "deepseek-flash" },
  "style": "default", "fromContext": false }

// 失败
{ "ok": false, "error": "草稿为空" }
```

| 状态码 | 含义 |
|---|---|
| 200 | 改写成功 |
| 400 | 草稿为空（且未开启"按上下文生成"） |
| 403 | 插件已在设置里关闭 / 来源不被信任 |
| 413 | 草稿超过 12000 字符 |
| 422 | 空草稿 + 「按最近对话生成」但会话没有可用上下文 |
| 502 | 模型调用失败 / 模型没返回内容 |
| 503 | 没有可用的模型路由 |

## 已知边界

- **引用的改写暂不支持**：含芯片的草稿只能置灰。DSH 当前插件面只提供 `setDraft`（纯文本、且会剔除引用占位符），要做"保留引用的改写"需要上游在 `InputActions` 上补一个 chip-aware 写入接口。
- **新会话（Hero）不显示按钮**：`conversation.input.right` 是会话级槽位，没有 sessionId 时不渲染。
- **改写是"重写"而不是"续写"**：它会替换整段草稿；如果只想追加，等后续版本。
- 模型偶尔会无视"不要代码围栏"的规则，服务端会兜底剥掉一层围栏。

## 安装

### GitHub Release（当前分发通道）

下载 [最新 Release](https://github.com/zzy6-a/dsh-prompt-enhance/releases/latest) 里的 `dsh-prompt-enhance-<version>.tgz`，装进你的 profile：

```bash
cd ~/.dsh/profiles/web
npm i /path/to/dsh-prompt-enhance-0.1.0.tgz
# 再把 dsh.profile.bundles 里加上 "dsh-prompt-enhance"
```

### dshmarket

市场收录后可直接搜索安装（见 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)）。

### 本地源码（开发）

```bash
git clone https://github.com/zzy6-a/dsh-prompt-enhance.git
cd dsh-prompt-enhance
npm install
npm run build
# 用你自己的插件加载方式挂进 profile（bundle patch 在 cordis.patch.yml）
```

## 环境要求

- Node.js ≥ 22.19
- DSH ≥ `0.1.5-rc.1`（`dsh.web` 前端 + `settings` / `sessions` / `llm` / `webServer` 服务）
- 改写需要一个可用模型路由（跟随会话模型或设置里固定）

## 开发

```bash
npm install        # 只装 4 个 devDependencies（schemastery / @types/node / tsdown / typescript）
npm run build      # host: tsc → lib/，client: tsdown → lib/client.js
npm run typecheck
npm test           # node:test，6 个 host 侧单测
npm pack           # 产出 dsh-prompt-enhance-<version>.tgz
```

目录：

```
src/index.ts            host 半区：HTTP 路由 + 提示词组装 + LLM 调用
src/client/index.ts     client 半区：composer ✨ 按钮、撤销、设置分区、导航图标装饰
scripts/build.sh        host 构建（优先本地 tsc，回退到 DSH 运行时）
cordis.patch.yml        bundle 层：插入插件行
dsh.plugin.json         插件清单（id / engines / client 入口）
test/                   node:test 单测
```

## 安全与边界

- 路由只在**同源 / 环回**来源下服务（其余 403）；
- 请求体上限 64 KB，草稿上限 12000 字符，单次调用端到端超时 90 秒；
- 不落盘草稿、不写会话日志；
- 插件的唯一网络行为就是把你的草稿发给你自己配置的模型路由。

## License

[MIT](LICENSE) © 2026 zzy6-a
