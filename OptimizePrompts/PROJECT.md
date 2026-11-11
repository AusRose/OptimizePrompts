# Optimize Prompts 项目文档

本文档说明插件的目标、结构、运行时行为、接口契约和调试方法，供维护与二次开发使用。面向安装与日常使用的说明见 [README.md](README.md)。

- 插件名：`dsh-optimize-prompts`
- 版本：`1.1.0`
- 类型：DSH Cordis 插件（Host 半体 + Web 客户端半体）
- 运行位置：DeepSeek Harness 的 Web 组合
- 许可证：MIT

## 1. 目标与边界

插件解决的问题只有一个：**在发送之前，把输入框里的草稿改写成一个更清晰、更可执行的提示词，并把这次改写真正依赖的文件与技能追加到末尾**。

因此它刻意不做以下事情：

- 不自动发送，不替用户确认；
- 不改变聊天会话的模型、思考强度或历史；
- 不把改写结果写成会话消息；
- 不采信模型直接写出的引用令牌：文件必须先命中工作区索引，技能必须先命中当前会话可见的技能目录；
- 不覆盖 DSH 自带的输入框、权限选择器或设置页组件。

改写是一次独立的模型请求，使用 DSH 已经配置好的 provider、凭证和适配器；引用校验复用会话自己的文件索引与技能目录。

## 2. 与模板（PromptForge）的差异

| 方面 | PromptForge 模板 | 本项目 |
| --- | --- | --- |
| 按钮位置 | `conversation.input.right`（发送控件旁） | `conversation.input.left`（权限预设「工作区内修改」旁） |
| 自动引用 | 文件 + 技能，候选发现与二次提名 | 同一套校验与提名思路，输出结构化的 `referenceStatus` |
| 设置页 | 模型、强度、文件、技能、图片、指令 | 模型、强度、文件、技能四档、图片、指令 |
| 请求体上限 | 512 KiB | 40 MiB，且超限返回 413 而不是断开连接 |
| 图片数量 | Host 直接拒绝 5 张以上 | 浏览器先截断到 4 张，Host 再校验 |
| 模型校验 | 只校验 provider 是否存在 | provider + `listModels` 双重校验 |
| 生成文件 | `lib/`、根目录镜像、配图、测试、覆盖率工具 | 只保留 `lib/`、`src/`、构建脚本和文档 |
| 图片结果 | 从 notes 文本里正则判断 | Host 返回结构化的 `imageStatus` |
| 引用结果 | 状态由文本推断 | Host 返回 `referenceStatus` + 实际追加的路径/技能数组 |

## 3. 目录结构

```text
OptimizePrompts/
├─ package.json          DSH 插件清单、exports、dsh.bundle / dsh.client 声明
├─ cordis.patch.yml      向 Web 组合 insert 一行插件
├─ icon.svg              插件列表图标
├─ build.mjs             无依赖构建脚本
├─ README.md             安装与使用说明
├─ PROJECT.md            本文档
├─ locale/
│  ├─ zh.json            插件列表中文标题与描述
│  └─ en.json            插件列表英文标题与描述
├─ src/
│  ├─ shared.js          两半共享的常量、默认指令、引用语法、设置归一化
│  ├─ host.js            HTTP 路由、设置存储、模型调用、图片准入、引用校验
│  └─ client.js          按钮、引用状态、设置页、状态管理、样式与文案
└─ lib/
   ├─ index.js           构建产物：shared + host
   └─ client.js          构建产物：模块工厂 + shared + client
```

`lib/` 是生成目录，不应手改。没有根目录镜像、配图、测试或覆盖率工具；这些在模板里用于发布与验证，本插件不需要。

## 4. 总体架构

```text
┌──────────────────────── 浏览器（DSH Web） ────────────────────────┐
│ conversation.input.left                                            │
│   OptimizeButton                                                   │
│     • 读取 draft / draftRev / phase / attachmentIds                │
│     • 需要时把附件序列化成 base64 图片（最多 4 张）                 │
│     • POST /optimize-prompts/run                                   │
│     • 校验草稿未变 → inputActions.setDraft(prompt)                 │
│                                                                    │
│ settings.section                                                   │
│   SettingsPage → settingsStore / catalogStore                      │
│     • GET/POST /optimize-prompts/state                             │
│     • ctx.remote.session.modelCatalog()                            │
└───────────────────────────────┬────────────────────────────────────┘
                                │ same-origin fetch
┌───────────────────────────────▼────────────────────────────────────┐
│ Host（Cordis 行 dsh-optimize-prompts）                             │
│   webServer 三条 exact 路由                                        │
│   live.state ← $DSH_HOME/optimize-prompts.json（原子写入）          │
│   optimizePrompt()                                                 │
│     resolveRoute → 组装 system/user → 图片准入 → llm.stream        │
│     → 汇总文本 → 路径保护 → 文件/技能校验 → 追加引用 → JSON 结果   │
└───────────────────────────────┬────────────────────────────────────┘
                                │ llm + fileReferences + skills
┌───────────────────────────────▼────────────────────────────────────┐
│ DSH 已配置的 provider / 模型 / 凭证 / 附件 / 文件索引 / 技能目录    │
└────────────────────────────────────────────────────────────────────┘
```

### 一次点击的完整流程

1. 用户点击「优化」。
2. 客户端记录 `text`、`draftRev`、`sessionId`，把 `attachmentIds` 序列化为图片（如果设置开启）。
3. `POST /optimize-prompts/run`，body 为 `{ text, sessionId, images? }`。
4. Host 校验文本长度、图片字段和路由。
5. 读取设置中的系统指令；需要引用时用 JSON envelope 替换掉“只回正文”的输出契约。
6. 若带图且模型支持视觉，图片经 `attachments.admitPromptContent` 准入后排在文字之前。
7. `llm.stream` 流式返回；Host 只拼接 `text-delta`，忽略 reasoning，检查 finish 原因和 tool-call。
8. 解析正文与文件/技能提名；输出为空、超长、或丢失原稿路径时保留原稿。
9. 文件提名经 `fileReferences` 索引校验，技能提名经 `skills` 目录校验；没有命中时用真实候选再问一次。
10. 校验通过的引用按 `@路径` / `/技能名` 追加到末尾，并返回实际新增的项目。
11. 客户端确认草稿、修订号、会话、组件生命周期和提交阶段都没有变化，才调用 `setDraft`。
12. 按钮短暂显示引用/图片结果，不会自动发送。

## 5. Host 半体

### 5.1 设置存储

- 路径：`process.env.DSH_HOME || ~/.dsh` 下的 `optimize-prompts.json`。
- 读取：文件缺失、为空或损坏时回到默认值，不阻塞插件加载。
- 写入：先写 `*.tmp`，再 `rename`，避免半写入。
- 内存：`live.state` 是路由共享的权威副本；磁盘是持久副本。
- 合并：`POST /state` 只接受对象，字段经 `normalizeState` 校验后与当前值合并。

### 5.2 路由

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` / `HEAD` | `/optimize-prompts/state` | 读取完整设置 |
| `POST` | `/optimize-prompts/state` | 合并补丁并持久化，返回归一化后的完整设置 |
| `POST` | `/optimize-prompts/run` | 执行一次改写 |
| `POST` | `/optimize-prompts/report` | 记录客户端失败到 Host stderr |

所有路由都以 `kind: 'exact'` 注册，并通过 `ctx.inject(['webServer'], …)` 等待 Web 服务；`llm` 在调用时通过 `ctx.get('llm')` 读取，避免插件行阻塞在可选服务上。

### 5.3 `POST /run` 契约

请求：

```json
{
  "text": "要改写的草稿",
  "sessionId": "当前会话 id，用于限定文件索引与技能目录的作用域",
  "images": [
    { "mediaType": "image/png", "data": "base64…", "name": "可选" }
  ]
}
```

成功响应：

```json
{
  "prompt": "改写后的提示词",
  "route": { "provider": "deepseek-account", "model": "deepseek-flash", "reasoningEffort": "可选" },
  "imageStatus": "sent",
  "referenceStatus": "complete",
  "files": ["src/host.js"],
  "skills": ["office-docx"],
  "preserved": false,
  "imageError": "可选，图片准入失败时的底层信息",
  "notes": ["可选，引用阶段的部分失败说明"]
}
```

`preserved: true` 表示改写丢失了原稿中的路径或引用，Host 返回的是原稿本身，`referenceStatus` 为 `preserved`。

`referenceStatus` 的取值：

| 值 | 含义 |
| --- | --- |
| `complete` | 至少追加了一个经过校验的文件或技能引用 |
| `none` | 校验完成，但没有可追加的项目 |
| `partial` | 引用处理部分失败（索引/目录不可用、超时、提名无效等），正文仍有效 |
| `preserved` | 改写丢失原始路径，返回原稿 |
| `disabled` | 文件与技能引用都关闭 |

错误：

| 状态 | 场景 |
| --- | --- |
| 400 | 草稿为空、超过 60,000 字符、图片字段非法、图片超过 4 张、没有可用模型 |
| 413 | 请求体超过 40 MiB，或单张图片 base64 超过 8 MiB |
| 500 | 设置文件写入失败等 Host 内部错误 |
| 503 | 当前组合没有 `llm` 服务 |

### 5.4 模型路由

`resolveRoute` 的顺序：

1. 设置中的 `provider` + `model`，前提是 provider 存在，且 `llm.listModels(provider)` 能确认 model（列表为空时视为无法反驳，保留配置）；
2. `deepseek-account` + `deepseek-flash`，前提是 provider 存在且模型可确认；
3. `agentDefaultModel.currentSelection()`；
4. 都没有时返回 400。

设置页的 `effectiveSelection` 使用同一顺序和同一份模型目录，所以页面显示的模型就是 Host 实际调用的模型。

### 5.5 图片准入

`composeUserContent` 的决策顺序：

1. 没有 `attachments` 服务 → 只发文字，`imageStatus: 'no-store'`；
2. `llm.resolveModelInfo` 明确返回不含 `image` 的 `inputModalities` → 只发文字，`imageStatus: 'text-only'`；
3. `attachments.admitPromptContent([...images, text])` 成功 → 图片在前、文字在后，`imageStatus: 'sent'`；
4. 准入抛错 → 只发文字，`imageStatus: 'failed'`，并带回 `imageError`。

任何图片问题都不会让文字改写失败。客户端根据 `imageStatus` 显示本地化提示。

### 5.6 文本汇总与结束原因

`accumulateText` 按 `chunk.index` 收集 `text-delta`，忽略 `reasoning-delta`，记录是否出现 `tool-call` 块和 `finish.reason`。

`finishFailure` 把以下原因翻译成错误：`length` / `max-tokens`、`tool-calls`、`content-filter`、`aborted`、`error`、未知原因。`stop` 视为成功。

### 5.7 路径保护

`lostOriginalPaths` 从原稿中提取三类 token：

- `@path` 与 `@"path with spaces"`；
- 含 `/` 或 `\` 的路径片段（跳过 URL）；
- 常见扩展名的文件名。

改写结果按 `/` 归一化后，如果缺少任意一个 token，Host 直接返回原稿并标记 `preserved`。这是一个保守的安全网：宁可这次不改写，也不把被模型删掉路径的草稿替换给用户。模型在 envelope 里提名的路径如果也出现在原稿中，同样参与这项检查。

### 5.8 引用校验与追加

`composeSystemPrompt` 在关闭引用时原样返回用户指令；开启时先删掉默认指令里的 `PLAIN_OUTPUT_CONTRACT`，再追加 JSON envelope，避免两个输出契约同时生效。

`readRewriteAnswer` 接受三种结果：

1. 完整 JSON envelope：正文、`files`、`skills` 都可用；
2. 代码围栏包住的 JSON：同样解析；
3. 纯文本：仍作为可用正文，提名留空，进入补充提名。

文件校验（`resolveFileReferences`）：

- 提名先归一化：反斜杠转 `/`、去掉 `@`/引号/`./`；
- 索引返回的候选必须命中文件名或路径片段，且落在段边界上；`ost` 不会命中 `src/host.js`；
- 精确路径优先；只有唯一候选才接受，歧义片段直接丢弃并记录；
- 目录提名校验目录自身，不用子文件顶替；
- 最终令牌由 `formatFileMention` 生成：普通 `@path`，含空格 `@"path"`，目录 `@"dir`。

技能校验（`resolveSkillReferences`）：

- 名称对当前 agent 可见的技能目录做精确匹配；
- 必须同时满足 `modelInvocable` 与 `userInvocable`；
- 最终写成 DSH 能识别的 `/kebab-case-name`；不符合手势语法的名字丢弃。

补充提名：

- 文件候选发现按“任务路径 → 根目录 → 常见目录”排序，最多 160 条、80 次查询；
- 技能候选最多 40 条，交给模型选择；
- 候选发现最多 5 秒，整个引用阶段 15 秒，提名调用预留 3 秒给校验；
- 模型或索引忽略取消时，仍返回有效正文和已经确认的引用。

追加（`appendReferences`）：

- 文件组标题 `Files this task needs:`，技能组标题 `Skills this task may need:`；
- 上一轮的组会被识别并重建，不会叠加第二个标题；
- 代码围栏内的同名标题按示例保留；
- 已有引用合并去重；新增引用超出 60,000 字符上限时省略并标记；
- 返回实际新增的 `files` / `skills`，状态按实际新增数计算。

### 5.9 超时与长度

- 模型调用：`AbortSignal.timeout(120_000)`。
- 输入：60,000 字符。
- 输出：4,096 tokens；输出文本再次受 60,000 字符上限约束。
- 请求体：40 MiB；单图 base64：8 MiB；图片张数：4。
- 引用阶段：15 秒总预算；文件提名最多 5 个，严格/均衡档技能提名最多 3 个，宽松档不设数量上限。

## 6. 客户端半体

### 6.1 插槽

| 插槽 | 用途 | 说明 |
| --- | --- | --- |
| `conversation.input.left` | 优化按钮 | 在 DSH 输入框的 `tools` 行内，紧跟 `conversation.input.permission`（「工作区内修改」）和 `conversation.input.plan` |
| `settings.section` | 设置页 | 与 DSH 其他设置分区并列，`order: 40` |

`conversation.input.permission` 本身是 `single` 槽，由 DSH 的权限预设包占用，不能被第二个插件追加。因此插件选择相邻的 `list` 槽 `conversation.input.left`，既位于同一个工具行、紧挨权限选择器，又不覆盖任何自带 UI。

### 6.2 按钮状态机

```text
idle ──click──▶ busy ──成功──▶ done ──4.2s──▶ idle
                    │
                    ├─失败──▶ failed ──3.2s──▶ idle
                    └─草稿已变/组件卸载──▶ idle（不写回）
```

- 草稿为空时不渲染。
- 发送提交阶段（`adjudicating` / `submitting`）按钮禁用。
- `running` ref 防止重复点击。
- 按钮带 `aria-label`、`aria-busy` 和 `Tooltip`；忙碌时显示加载图标，成功/失败时短暂变绿/变红。

### 6.3 草稿保护

异步返回后同时检查：

- `mounted`：组件是否还挂载；
- `current.draft === text`：草稿文本是否被改过；
- `current.draftRev === revision`：草稿修订号是否变化；
- `current.sessionId === sessionId`：是否切换了会话；
- `current.phase` 不是 `adjudicating` / `submitting`：是否正在发送。

任何一个条件不满足都不写回，避免迟到的结果覆盖用户的新输入。

### 6.4 图片收集

- 通过 `conversation.serializeDraftAttachments(ids)` 读取草稿附件的字节。
- 只保留 `type === 'image'` 且有 `data` 的条目。
- 发送前 `.slice(0, 4)`，与 Host 的上限一致；这样第 5 张图不会让整次优化失败。
- 设置 `includeImages === false` 时完全跳过序列化，省掉 base64 开销。

### 6.5 设置页

- `settingsStore`：模块级 store，乐观更新 + 串行保存；失败显示错误但保留本地值。
- `catalogStore`：页面加载时读取一次 `ctx.remote.session.modelCatalog()`。
- 模型和强度使用自绘下拉，包含搜索、分组标题、当前项勾选、Esc/外部点击关闭。
- 自动引用区提供文件开关与技能四档下拉；技能档位会改变提名措辞与数量上限（宽松档不限数量），但都不放宽目录校验。
- 指令 textarea 在失焦时保存；「恢复默认」提交空字符串，由 Host 归一化为内置指令。
- 保存状态：`正在保存…` / `已保存` / `保存失败：…`。
- `lastReferenceResult`：按钮成功时写入，设置页显示“最近一次引用处理”，包括已确认、未发现、未完成、原稿保留和已关闭。

### 6.6 样式与文案

- CSS 全部使用 `--dsw-*` 主题 token，自动适配明暗主题。
- 类名统一 `OP-` 前缀，避免与 DSH 或其他插件冲突。
- 中英文文案都在 `client.js` 内；简体中文是键集合的源，英文必须一一对应。

## 7. 构建

`node build.mjs` 做三件事：

1. 读取 `package.json` 的版本号；
2. 把 `src/shared.js` 分别内联进 Host 产物和客户端工厂；
3. 把 `src/client.js` 的 `import` 改写成 `require`、`export` 改写成 `exports.*`，再包进：

```js
window.__ModuleLoader__.load({
  id: "dsh-optimize-prompts",
  factory: (require) => { … return module.exports; }
});
```

输出只有 `lib/index.js` 与 `lib/client.js`。`package.json` 的 `exports` 指向这两个文件。

### 7.1 安装位置

插件源码应放在 profile 之外的稳定目录，例如 `C:/path/to/OptimizePrompts`。安装动作由 DSH 的插件管理器完成，它会：

1. 在 profile 的 `package.json` 写入依赖，例如
   `"dsh-optimize-prompts": "link:C:/path/to/OptimizePrompts"`；
2. 在 `dsh.profile.bundles` 中加入 `dsh-optimize-prompts`；
3. 运行 pnpm，在 profile 的 `node_modules` 下创建指向该目录的 junction/symlink；
4. 更新 `pnpm-lock.yaml`。

因此 **不要把源码复制进 profile 的 `node_modules`**。那个目录由 pnpm 生成，没有依赖记录的文件夹会在下一次安装时被移动到 `node_modules/.ignored`；插件也不会出现在列表里，因为 profile 的 `package.json` 从未声明它。

桌面 profile 中的正确安装结果形如：

```text
C:\Users\root\.dsh\profiles\desktop\package.json
  dependencies:
    "dsh-optimize-prompts": "link:C:/path/to/OptimizePrompts"
  dsh.profile.bundles:
    … , "dsh-optimize-prompts"

C:\Users\root\.dsh\profiles\desktop\node_modules\dsh-optimize-prompts
  → junction → C:\path\to\OptimizePrompts
```

如果移动了源码目录，需要重新添加插件或更新 `link:` 路径；只移动目录会让 junction 悬空。

> 目录名中的连字符建议使用普通 ASCII `-`。从聊天或文档复制路径时，可能带入 U+2011（非断行连字符），外观相同但 `Test-Path`、`cd` 和 CLI 都可能找不到。安装时最好用插件管理器的目录选择器，而不是手抄路径。

## 8. 调试

### 8.1 确认插件已加载

在 DSH Web 的同一地址上请求：

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/optimize-prompts/state
```

返回设置 JSON 说明 Host 路由已注册。404 通常表示插件未启用、未重启或 bundle 未装配。

### 8.2 直接调用改写

```powershell
$body = @{ text = '检查登录接口的错误处理，补充测试' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<port>/optimize-prompts/run `
  -ContentType 'application/json' -Body $body
```

返回 `prompt` 即改写结果；`preserved` 为 `true` 时说明原稿被保留。

### 8.3 查看客户端失败

按钮失败时会 `POST /optimize-prompts/report`，Host 把内容写到 stderr：

```text
[optimize-prompts] client report: …
```

同时设置页会显示「最近一次优化失败」。

### 8.4 常见定位顺序

1. `GET /optimize-prompts/state` 是否 200；
2. 设置页模型目录是否能加载；
3. `POST /run` 的错误信息是 400、413 还是 503；
4. 若模型返回但草稿未变，检查浏览器控制台是否触发草稿保护；
5. 若图片未生效，检查 `imageStatus`：`text-only` / `no-store` / `failed` / `disabled`；
6. 若没有追加引用，检查 `referenceStatus` 与 `notes`，以及当前会话是否关联正确工作区、文件索引和技能目录是否可用。

## 9. 已知限制

- 三条路由不参与 DSH 的授权校验，也不检查 `Origin`；任何本机进程都能读取设置或触发一次改写。风险限于本机与模型配额，与模板的既有实现一致。
- 优化调用与聊天请求共用 provider 凭证和速率限制；同一输入框内已串行化，跨标签页没有全局互斥。
- 只接受 `image/png`、`image/jpeg`、`image/webp`、`image/gif`。
- 模型输出上限 4,096 tokens，超长草稿可能先触发长度限制。
- 若 provider 的 `listModels` 返回空列表，Host 会信任设置中的模型，而不是判定它不存在；最终仍由 provider 调用结果决定。
- 引用阶段可能触发第二次模型请求（候选补充提名），因此开启引用会拉长等待时间；15 秒预算用尽时返回正文与已有引用。
- 引用校验依赖当前会话的 `fileReferences` 与 `skills` 服务；服务缺失时正文仍会返回，`referenceStatus` 为 `partial`。
- 长路径保护是启发式的；它可能把一次本可接受的改写判为“丢失路径”并保留原稿。这是有意偏保守。
- 没有随包发布自动化测试；`build.mjs` 只做构建。开发时的冒烟覆盖了路由、图片、引用提名/校验/二次提名、草稿保护和真实 HTTP 超限，但真实 DSH 浏览器内的视觉与交互仍需安装后复核。

## 10. 可能的扩展

- 流式把改写结果写回输入框（当前是完成后一次性替换）。
- 取消按钮：把点击时的 `AbortController` 传到 Host，提前终止模型请求。
- 多档改写风格（精简 / 标准 / 详细），复用现有 `systemPrompt` 存储结构即可。
- 为设置页增加导航图标，复用 DSH 设置页的图标注入技巧。
- 引用结果的可展开明细（当前只显示数量与状态）。

## 11. 变更记录

### 1.1.0

- 新增文件引用：模型提名路径，经当前会话文件索引校验后追加 `@路径`。
- 新增技能引用：四档（关闭/严格/均衡/宽松），经技能目录双调用策略校验后追加 `/技能名`。
- 引用阶段共用 15 秒预算；缺失提名时用真实候选补充提问一次。
- 改写丢失原始路径时保留原稿，并把状态标记为 `preserved`。
- 设置页新增引用文件开关、技能档位和最近一次引用处理结果。
- 版本号提升到 `1.1.0`。

### 1.0.0

- 首个版本：权限选择器旁的优化按钮、识图、模型/强度/指令设置、草稿保护。
- 浏览器端图片截断到 4 张；Host 端 40 MiB 请求体上限并以 413 返回超限。
- Host 使用 `listModels` 校验保存的模型，失效时回退到首选/默认模型。
