# AGENTS.md — dsh-user-manager

DeepSeek Harness（`dsh`）插件：用户管理（数据库 / LDAP）+ 会话按用户隔离。
未登录时注入登录遮罩；`/api/<method>` 在 HTTP 层做登录态校验、归属过滤与越权拒绝。

本插件是**独立项目**（不进入 harness monorepo），采用 `tsc` 编译 +
`scripts/wrap-client.mjs` 闭包工厂打包的"独立构建"工作流。改动前先读本文件，
并优先参照 `.workbuddy/skills/dsh-plugin-dev/SKILL.md`（插件开发契约与 harness 扩展点）。

---

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | **宿主半**插件入口。装配路由、用户目录、登录遮罩注入。导出 `name / inject / Config / apply`。 |
| `src/config.ts` | 配置 Schema（`Schema.object`）、`DSH_HOME` 解析、管理员环境变量读取、按 mode 校验必填项。 |
| `src/auth.ts` | scrypt 口令哈希、HMAC-SHA256 登录态票据签发/校验、吊销表、Cookie 读写。 |
| `src/session-lookup.ts` | `AuthLookup` —— 按 Cookie 取主体所需的最小依赖，供 gate 与 http 共用。 |
| `src/store.ts` | `StateStore`：`$DSH_HOME/user-manager.yaml` 的读写（连接配置 + 会话归属索引）。 |
| `src/db/dialect.ts` | SQL 方言差异（引号 / 占位符 / 布尔）与三种引擎的懒加载连接、建表。 |
| `src/db/user-directory.ts` | `DatabaseUserDirectory`：用户表上的增删改查与认证。 |
| `src/ldap.ts` | `LdapUserDirectory`：只读 LDAP 目录（两段式绑定认证）+ 连接自检。 |
| `src/http.ts` | `/user-manager/*` 自控路由：登录 / 登出 / me / 用户管理 / 连接配置与测试。 |
| `src/gate.ts` | `/api/<method>` 影子路由：登录态校验、归属过滤、越权拒绝、转调 `ctx.apiProxy`；并为 `/api/events.mux` / `/api/events.host` 各留一条 **HTTP GET 兜底**流（`proxyStream`，真实浏览器不走它，供非浏览器调用方与调试）。帧过滤谓词 `muxPredicate` / `hostPredicate` 在本文件导出，供 events-ws 复用。 |
| `src/events-ws.ts` | **实时事件流隔离（真正的生效路径）**：浏览器走 WebSocket 升级，绕过 HTTP 路由。本模块拦截 http server 的 `upgrade` 事件做 Cookie 鉴权 + AsyncLocalStorage 传身份，并包装 `apiProxy.events.mux/host` 逐帧过滤。 |
| `src/diag.ts` | 临时诊断落盘（写 `os.tmpdir()/dsh-gate.log`）。 |
| `src/login-page.ts` | 独立登录页 HTML。 |
| `src/client.ts` | **浏览器半**。自包含 bundle（**刻意无任何 import/export**），登录遮罩 + 多页面用户面板。面板内分四页：`buildUserListPage`（用户列表，管理员）、`buildCreateUserPage`（新建用户，管理员）、`buildConfigPage`（用户库配置，管理员）、`buildPasswordPage`（我的密码，所有人）；`buildPanel` 用 `navigate` 做页间切换，仅 1 个可见页时隐藏导航栏。 |
| `src/types.ts` | 共享类型（配置、用户记录、目录接口）。 |
| `scripts/wrap-client.mjs` | 把 `lib/client.js` 包成 `window.__ModuleLoader__.load({ id, factory })` 惰性 CJS bundle。 |
| `scripts/smoke.mjs` | 运行时烟测：口令哈希 / 票据 / 吊销 / 归属索引 / SQLite 用户库。 |
| `scripts/integration.mjs` | 端到端装配测试：假 cordis 上下文驱动真实插件，覆盖登录 → 过滤 → 越权拒绝 → 登出 → 释放。 |
| `cordis.patch.yml` | 把插件行 `id: user-manager / name: dsh-user-manager` 插入 profile 配置树。 |

---

## 常用命令

```bash
npm install                                   # 安装依赖
npm run typecheck                             # tsc --noEmit
npm run build                                 # tsc + wrap-client
npm test                                      # smoke + integration（74 项断言）
npx @deepseek-ai/dsh plugin --profile web add .   # 链接进 web profile
npx @deepseek-ai/dsh --profile web --dump-config  # 校验插件树加载
```

> **改任何源码后必须重启 host。** 插件集在 boot 时扫描并缓存。

---

## 核心约定（违反即破坏构建/运行）

1. **两半分离、独立构建。** 宿主逻辑只在 `src/index.ts` 及其依赖里，浏览器逻辑只在
   `src/client.ts`。两者不共享模块 —— `client.ts` 不能 `import` 任何东西。
2. **`client.ts` 必须是纯脚本。** 无 `import` / `export`，且**不能用 TS 特有语法**
   （`enum` / `namespace` / 参数属性 / `satisfies` / `declare global`），否则 tsc 会产出
   无法直接执行的语句。类型用 `interface` 声明并显式 `as unknown as X` 收窄 DOM 元素。
3. **所有注册可逆。** 用 `ctx.effect(() => disposer)` 管理副作用与清理。
4. **插件元数据用具名导出。** 禁止 `export default`（会丢失 `inject` 元数据）。
5. **不臆造 API。** harness 服务签名以 `../deepseek-harness/packages/...` 源码为准。

---

## API 契约速查

### `ctx.webServer`（硬依赖，`inject: ['webServer']`）

```ts
register({ kind: 'exact' | 'prefix', path, handler: (req, res) => void }) => disposer
registerUpgrade({ path, handler }) => disposer      // 同路径重复注册会抛错
registerFallback(handler) => disposer               // 唯一席位，已被 SPA 占用
tapIndex((html: string) => string) => disposer      // index.html 原文变换
```

- 匹配顺序：**exact 表 → 最长前缀**。`connection` 插件把 `/api` 注册为 prefix，
  所以 exact 注册 `/api/session.list` 能**压过**它 —— 这是本插件隔离机制的基础。
- **两条实时事件流是 WebSocket 升级，不是 SSE（关键事实，此前误判已修正）**。
  `api-path.ts` 明确写着 "Browser mux-frame WebSocket pathname"：浏览器对
  `/api/events.mux` / `/api/events.host` 发的是 `GET + Upgrade: websocket`，由
  `WebSocketDownlinks` 承载；webserver 的升级分发走**独立的 `upgrades` 表**，
  HTTP 的 exact/prefix 路由**完全不参与**。而 plain GET 这两条路径会被 harness
  回 `426 Upgrade Required` —— 也就是说 HTTP 层接管对浏览器毫无作用。
  本插件因此改为两件事（见 `src/events-ws.ts`）：
  1. 在 http server 上**替换 `upgrade` 监听器**（`server.listeners('upgrade')` +
     摘除 + 包装）：事件流路径先过 Cookie 鉴权（未登录 401），再把「本连接的
     帧过滤器」放进 `AsyncLocalStorage`，最后调用原监听器；
  2. **包装 `apiProxy.events.mux/host`**：downlink 每次升级都在调用栈内同步打开
     上游流（ws 的 `handleUpgrade` 回调同步执行，ALS 上下文必然存活），包装层
     读到上下文即逐帧过滤；无上下文（进程内其他调用方）原样透传。
  gate.ts 里的 exact GET 兜底路由保留，只服务非浏览器调用方与手工验证。
- **过滤维度是 owner 而非 allowed（关键坑）**：harness 在 `session.create` 执行期间就广播
  `host/session-added` / `host/workspace-changed`，而认领归属在 create 返回后才写入。新建会话在
  广播瞬间是"无主"的，若用 `allowed`（无主对管理员可见）管理员会实时收到他人刚建的会话。所以
  `muxPredicate` / `hostPredicate` 一律按 `owned()`（verdict === 'owner'）过滤；无主会话不进任何人的
  实时流，只在 `session.list` / `workspace.list` 基线按 `unownedSessions` 对管理员可见（只读、无实时更新）。
  子代理会话在 `claimSubagentChild` 里借 `host/session-added` 的 `parentSessionId` 认领给父会话拥有者。
- `tapIndex` 在所有结构化注入行之后应用，因此插在 `<body>` 之后的脚本排在
  应用自带 script 之前，正好能挡住未登录首屏。

### `ctx.apiProxy`（**必须 `ctx.inject(['apiProxy'], cb)` 取，不能只靠 apply 时 `ctx.get`**）

**最大的一次线上事故根因（2026-08-31 实测）**：本插件只 `inject: ['webServer']`，
apply 时 `apiProxy` **可能尚未构造**，`ctx.get('apiProxy')` 返回 `undefined` ——
旧代码这时就只打一条日志、整个 gate 静默跳过，结果是：归属索引从不落盘、所有
会话都变「无主」、隔离形同虚设，而且表现为「时好时坏」（同一份代码两次启动，
一次 present 一次 undefined）。**正确写法**：

```ts
const existing = ctx.get('apiProxy') as ApiProxyLike | undefined
if (existing !== undefined) setup(existing)
else ctx.inject(['apiProxy'], apiCtx => { const api = apiCtx.apiProxy; if (api) setup(api) })
```

不依赖 apiProxy 的部分（升级分发鉴权）仍在 apply 时同步安装，不推迟。

域 → 方法：`sessions` / `subagents` / `host` / `workspace` / `skills` /
`agentPresets` / `goals` / `settings` / `credentials` / `llm` / `downloads` / `respond`。
注意 `ctx.get` 拿到的是代理对象，`Object.keys` 只枚举得到部分字段（实测
apply 阶段只有 `sessions,events`），诊断时别只看 keys。

每个方法签名都是 `(request: { rpcId, payload }, signal?): Promise<{ rpcId, result }>`，
`result` 是 `{ ok: true, value } | { ok: false, error }`。**注意**：官方实现不自行校验
payload（校验在 `toFetchHandler` 的路由表里），插件直接调方法时要自己保证 payload 形状。

**方法前缀 → 域名的映射在 `src/gate.ts` 的 `DOMAIN_OF`**（`session` → `sessions`、
`agentPreset` → `agentPresets`）。不是简单加 `s`，必须由表决定。

### 为什么不用 `ctx.connection.rpc.handle`

其回调签名是 `(endpoint, payload, signal) => Promise<RpcResult>` —— **读不到 HTTP 头**，
拿不到 Cookie，识别不了调用者。所以它只能做无鉴权的功能端点（如 role-manager）。

### 错误码

`RpcError` 是**闭合**判别联合（`rpc.schema.ts` 的 `rpcErrorSchema`），没有 `unauthorized`。
业务层拒绝统一用 `code: 'bad-request', details: { issues: [] }`；
不要用 `internal`（部分客户端会触发重试）。HTTP 状态保持 200 —— 状态只表达载体层。

---

## 如何扩展

**新增一个被鉴权拦截的 /api 方法**：在 `src/gate.ts` 的 `METHOD_RULES` 加一行。
键是方法名（`session.xxx`），可选 `sessionIdField`（按 payload 字段校验归属）、
`filter: 'session-list'`、`filterWorkspace: true`、`claim: true`、`adminOnly: true`。
未列出的方法**直接放行**（不在规则表 = 不接管的路由）。

**新增 /user-manager 端点**：在 `src/http.ts` 的 `registerUserRoutes` 里 `mount(path, handler)`，
需要管理员的加 `principal.role !== 'admin'` 判定。

**新增用户库模式**：实现 `src/types.ts` 的 `UserDirectory`（只读）或
`WritableUserDirectory`（可写），在 `src/index.ts` 的 `connectDirectory` 里接上分支。

---

## 已知坑（都踩过）

- **方法域名是复数且不规则**：`session.list` 的域是 `sessions`，`agentPreset.remove` 的域是
  `agentPresets`。用 `method.lastIndexOf('.')` 切分后**必须**查 `DOMAIN_OF` 表，
  否则表现为运行时 `api method xxx unavailable`。
- **切域名时别用 `indexOf('.')`**：`agentPreset.openDocument` 之类只有最后一个点才是分隔。
- **`cordis` 的 `ctx.get(name)` 返回的是代理对象**，自有字段是枚举的（可 `Object.keys`），
  但原型上的属性不在 keys 里。诊断时别只看 `Object.keys`。
- **切换用户目录必须关掉旧连接**：SQLite 会一直锁着文件，Windows 上表现为
  `EBUSY: resource busy or locked`，且删除/重建都会失败。见 `switchDirectory`。
- **假 `res` 必须是 EventEmitter**：`gate.invoke` 会在 `res` 上挂 `close` 监听以传递取消信号。
  测试里给假响应补 `on`/`off`，否则每次都返回 500 `handler failure: ... is not a function`。
- **假 `req` 别用 `Object.assign(Readable.from(...), {...})`**：会覆盖 `Readable` 的
  `on`/`off`，导致 `for await (const chunk of req)` 永久挂起。用 `class X extends Readable`。
- **驱动是 `optionalDependencies`**：缺包时用 `createRequire(import.meta.url)` 惰性 require，
  失败要给出"装哪个包"的可操作提示，不要抛原始栈。
- **`systemPrompt` 分节文本会被强制做 `{{variable}}` 插值**，任何 `{{...}}` 都会令装配抛错
  （role-manager 的教训）。本插件不注入提示词，但若将来要注入，必须先转义 `{ {`。
- **Windows 上别用 `'/tmp/xxx.log'` 写诊断文件**：Node 按 cwd 盘符解析成
  `<盘>:\tmp\xxx.log`，目录不存在时 `appendFileSync` 抛 ENOENT —— 若被 `catch{}` 吞掉，
  现象就是「探针好像从没跑过」，排查方向被带偏。用 `os.tmpdir()`（`src/diag.ts`）。
- **在 `D:\` 目录下跑 `npx @deepseek-ai/dsh` 会无限递归**：`D:\dsh.bat` 的内容就是
  `npx @deepseek-ai/dsh web`，而命令行解析 `dsh` 二进制时会优先命中 cwd 下的
  `dsh.bat`，于是子命令又调回 npx。实测表现为终端不断打印
  `D:\>npx @deepseek-ai/dsh web`、`'npx' 不是内部或外部命令`。手工启动 host 时换目录，
  或直接 `node <npx缓存>/@deepseek-ai/dsh/lib/bin.js web`（注意用 Windows 风格路径）。
- **手工验证会话新建要指定 `cwd`**：`session.create` 不带 cwd 会拿 Host 的 cwd，
  在受限环境里 `mkdir` 报 `EPERM`，create 返回 `ok:false` → 归属不会登记，
  看起来就像「认领失效」。给 payload 传一个已存在目录（如 `D:\tmp`）即可。
- **测试脚本的 Cookie 头别漏前缀**：必须是 `dsh_user=<token>`，写成裸 token 时
  服务端返回 401 且现象酷似「鉴权又坏了」。
- **Web 端的连通性与挂载只能在真实浏览器里验证**，本环境跑不了浏览器，相关改动需用户侧确认。

---

## 参考

- harness 源码（只读）：`../deepseek-harness/packages/`
  - 路由与注入：`packages/host/webserver/src/{index.ts,injections.ts}`
  - API 网关：`packages/host/apiproxy/src/{index.ts,api-proxy.ts,fetch/handler.ts,api/rpc-map.ts}`
  - 客户端连接：`packages/client/connection/src/{index.ts,rpc-host.ts,rpc.ts,websocket-downlink.ts}`
  - 信任栅栏（明确不是鉴权层）：`packages/client/connection/src/api-request-trust.ts`
- 同类插件（独立构建范例）：`../dsh-role-manager`、`../dsh-md-table-export`
- 插件开发技能：`.workbuddy/skills/dsh-plugin-dev/SKILL.md`
