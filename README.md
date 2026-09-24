# dsh-prompt-enhance-local

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2f6fed)](https://github.com/topics/dsh-plugin)

> 本仓库是 [zzy6-a/dsh-prompt-enhance](https://github.com/zzy6-a/dsh-prompt-enhance)（MIT）的**本地加固 fork**，经逐行审计后做了安全修复与功能裁剪，只保留一件事：
>
> **Composer 里的一键提示词增强**——写完一句话，点一下 ✨，口语草稿被改写成目标明确、结构化的专业提示词，可一键撤销。

## 与上游的差异（v0.2.0）

**安全修复（3 项）**

| # | 上游问题 | 本 fork 的处理 |
|---|---|---|
| 1 | Origin 校验用 `startsWith('localhost')`，`http://localhost.evil.com` 这类恶意站点可绕过同源栅栏，盗用模型额度 | 改为 `URL.hostname` **精确匹配**回环集合 `{127.0.0.1, localhost, ::1, [::1]}` 或与 `Host` 头完全相等；附回归单测 |
| 2 | 无 Origin 头的请求（裸 curl、本机任意进程）直接放行 | **强制要求** Origin 头；同时校验浏览器的 `sec-fetch-site`（如发送必须为 `same-origin`） |
| 3 | 往 `~/.dsh/super-injector/*.log` 落盘诊断日志 | **彻底删除文件写入**，改用宿主 `ctx.logger`——对文件系统零写入 |

另新增**内存限流**（10 次/分钟，固定窗口，无依赖、不落盘），把"本机进程伪造头刷额度"的残余风险压到有界速率。诚实说明：回环 HTTP 没有真正的认证手段（DSH GUI 本身也无认证），本插件防到"顺手滥用"级别。

**功能裁剪（只留核心）**

- ❌ 删除"按最近对话生成"（空草稿策略）→ 连带**彻底不读取 sessions**，硬依赖降到 3 个（`webServer`/`llm`/`settings`）；空草稿一律置灰/拒绝
- ❌ 删除自定义 system 模板设置
- ❌ 删除落盘日志
- ✅ 保留：✨ 一键增强、↩ 撤销、五种改写风格、模型跟随/固定、总开关、芯片置灰保护

## 功能

| | |
|---|---|
| ✨ **一键增强** | 读取当前草稿 → 按风格改写（默认**结构化**：目标 / 范围 / 产出 / 约束 / 验收）→ 整稿替换 |
| ↩ **一键撤销** | 草稿没被手动改动前，撤销按钮一直在，点一下恢复原文 |
| 🎛 **五种改写风格** | 结构化（默认）· 补全细节 · 更简洁 · 更详细 · 加约束 |
| 🧭 **模型可跟随可固定** | 默认跟随当前会话的模型；也可固定一个便宜的模型专跑改写 |
| 🧩 **芯片保护** | 草稿含 `@文件引用`、`/命令`、skill 芯片时按钮置灰（整稿替换会切断这些引用） |

## 使用

1. 在输入框写下你的想法（一句口语也可以），比如 `把日志页的时间筛选换成下拉`；
2. 点模型选择器左边的 **✨**；
3. 按钮变成 `···`，完成后草稿被替换为改写后的提示词；
4. 不满意就点旁边的 **↩** 撤销，恢复原文。

## 设置

设置 → 左侧 **提示词增强**：

| 设置项 | 选项 | 默认 |
|---|---|---|
| 启用提示词增强按钮 | 开 / 关 | 开 |
| 改写风格 | 结构化 / 补全细节、明确目标 / 更简洁 / 更详细 / 加约束 | **结构化** |
| 模型 | 跟随当前会话 / 固定 provider + model | 跟随当前会话 |

配置存在宿主设置命名空间 `prompt-enhance-local`，改完立即生效（无需重启）。

## 工作原理

```
composer 草稿 ──POST /api/dsh-prompt-enhance-local/enhance──▶ host 半区
              （Origin + sec-fetch-site 栅栏 + 限流 + 64KB/12000字/90s 三重上限）
                                          │
                            system = 风格内置模板（本地常量）
                                          │
                              ctx.llm.stream（一次性调用，不写会话日志）
                                          │
       改写后的提示词 ◀──────── JSON ──────┘
              │
     inputActions.setDraft(text)  ← 整稿替换（可撤销）
```

- **一次性模型调用**：`hand-built` 请求，不进会话日志、不进 agent 上下文；
- **模型路由优先级**：设置里固定 → 会话最近一次主模型调用 → 宿主默认模型；
- **服务端只做三件事**：取风格模板、调用模型、剥掉多余代码围栏；**不落盘、不读会话、不发往任何第三方 endpoint**。

## 抗 harness 更新（设计 + 自检）

插件按"DSH 会一直进化"设计：

1. **最小 API 面**：只依赖 3 个官方 seam（`webServer.register` / `llm.stream` / `settings.register`），本地自带结构声明，构建只依赖 `schemastery` 一个包——上游类型怎么变都不影响编译安装；
2. **官方扩展点**：按钮挂官方槽位 `conversation.input.right`，写回用官方 `inputActions.setDraft`；槽位 kit 缺失时**只警告不崩溃**（最坏结果是按钮不出现，插件不拖累 profile）；
3. **降级链**：模型路由 固定设置 → 会话最近路由 → 宿主默认，任何一环缺失都有明确错误码；
4. **升级后自检**（每次升级 DSH 后跑一次，<1 分钟）：

```bash
node scripts/verify.mjs            # 默认打 http://127.0.0.1:3080
node scripts/verify.mjs --rate     # 额外验证限流（会吃掉当分钟配额）
DSH_BASE=http://host:port node scripts/verify.mjs   # 自定义地址
```

只发**无副作用**请求（永远走不到模型调用），验证 5 道护栏：405 方法 / 403 无 Origin / 403 伪造 Origin / 400 空草稿 / 413 超长。任一失败退出码 1，并打印排查顺序。

**兼容矩阵**：DSH ≥ `0.1.5-rc.1`（2026-09-24 本地实测通过）。

## 安装（本地 profile）

```bash
# 方式一：本地 link（开发态，改完源码重启即生效）
cd ~/.dsh/profiles/web
# package.json → dependencies 加：
#   "dsh-prompt-enhance-local": "link:D:/_02_MyProjectSpace/DeepseekSpace/2-dsh_plugin/dsh-prompt-enhance"
# package.json → dsh.profile.bundles 加：
#   "dsh-prompt-enhance-local"
# 再建符号链接并重启 dsh web

# 方式二：打包安装
npm pack        # 产出 dsh-prompt-enhance-local-0.2.0.tgz
```

## 安全边界（一句话版）

唯一网络行为 = 把你的草稿发给你自己配置的模型路由；同源栅栏拒绝一切外来请求；限流封顶；不落盘、不读会话、无第三方 endpoint、无 `eval`、无动态加载。

## License

MIT © 2026 ecircle6（本 fork）；上游 dsh-prompt-enhance © 2026 zzy6-a，MIT 许可，版权声明保留在 [LICENSE](LICENSE)。
