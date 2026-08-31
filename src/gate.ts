/**
 * `/api/<method>` 的鉴权与隔离层。
 *
 * 为什么影子化 HTTP 路由而不是用 `connection.rpc.handle`：
 * rpc.handle 回调只拿到 `(endpoint, payload, signal)`，读不到 Cookie，
 * 无法判断调用者是谁。而 `ctx.webServer` 的路由匹配是「exact 优先，其次最长
 * 前缀」，connection 插件把 `/api` 注册为 prefix，因此这里用 exact 注册
 * `/api/session.list` 之类的路径即可合法接管，同时拿到原生 req/res。
 *
 * 真实数据在同进程直接调用 `ctx.apiProxy` 的具名方法取得，不经 HTTP，
 * 因此不会自环回本插件的影子路由。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { principalFromRequest } from './http.js'
import type { AuthLookup } from './session-lookup.js'
import type { StateStore } from './store.js'
import type { PluginConfig, ResolvedAuthConfig, SessionPrincipal } from './types.js'

/** 影子化路由的固定前缀。 */
const API = '/api'

/** 请求体上限（提示类请求可带图片，放宽到 32MB）。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024

/** 单次方法访问规则。 */
interface MethodRule {
  /** payload 中承载会话 id 的字段名，用于校验归属。 */
  sessionIdField?: string
  /** 列举类：返回后按归属过滤会话条目。 */
  filter?: 'session-list'
  /** 工作区列举：按归属过滤 sessionIds。 */
  filterWorkspace?: boolean
  /** 建会话：成功后登记归属。 */
  claim?: boolean
  /** 仅管理员可调用。 */
  adminOnly?: true
}

/**
 * 方法规则表。刻意识别式列出：未列出的方法直接放行，
 * harness 新增方法不会因为插件没跟上而整体不可用。
 */
const METHOD_RULES: Record<string, MethodRule> = {
  'session.list': { filter: 'session-list' },
  'session.search': { filter: 'session-list' },
  'session.create': { claim: true },
  'session.history': { sessionIdField: 'sessionId' },
  'session.models': { sessionIdField: 'sessionId' },
  'session.selectModel': { sessionIdField: 'sessionId' },
  'session.rename': { sessionIdField: 'sessionId' },
  'session.fork': { sessionIdField: 'sessionId' },
  'session.prompt': { sessionIdField: 'sessionId' },
  'session.attachment': { sessionIdField: 'sessionId' },
  'session.updateQueue': { sessionIdField: 'sessionId' },
  'session.cancel': { sessionIdField: 'sessionId' },

  'subagent.list': { sessionIdField: 'parentSessionId' },
  'subagent.history': { sessionIdField: 'childSessionId' },
  'subagent.prompt': { sessionIdField: 'parentSessionId' },
  'subagent.interrupt': { sessionIdField: 'childSessionId' },

  'workspace.list': { filterWorkspace: true },
  'workspace.archiveSession': { sessionIdField: 'sessionId' },
  'workspace.insertSessionBefore': { sessionIdField: 'sessionId' },

  'settings.update': { adminOnly: true },
  'settings.replace': { adminOnly: true },
  'settings.mutate': { adminOnly: true },
  'settings.openDocument': { adminOnly: true },
  'credentials.set': { adminOnly: true },
  'credentials.unset': { adminOnly: true },
  'credentials.describe': { adminOnly: true },
  'host.openPath': { adminOnly: true },
  'host.createDirectory': { adminOnly: true },
  'agentPreset.remove': { adminOnly: true },
  'agentPreset.copy': { adminOnly: true },
  'agentPreset.openDocument': { adminOnly: true },
}

/**
 * 方法前缀 → `ctx.apiProxy` 上的域名。多数是复数，且 `agentPreset.*` 用的是驼峰
 * 前缀，无法从方法名推导，因此显式映射（写错即在此表暴露，而不是运行时报
 * "method unavailable"）。
 */
const DOMAIN_OF: Readonly<Record<string, string>> = {
  session: 'sessions',
  subagent: 'subagents',
  host: 'host',
  workspace: 'workspace',
  skill: 'skills',
  agentPreset: 'agentPresets',
  goal: 'goals',
  settings: 'settings',
  credentials: 'credentials',
  llm: 'llm',
}

/** 窄化的 RPC 请求 / 响应（与 harness 的 RpcRequest / RpcResponse 同形）。 */
interface RpcRequestLike {
  rpcId: string
  payload: Record<string, unknown>
}
interface RpcResponseLike {
  rpcId: string
  result: unknown
}

/** 需要转发信号的方法（签名里带 AbortSignal 的那些）。 */
const SIGNAL_METHODS: ReadonlySet<string> = new Set([
  'session.search',
  'subagent.list',
  'subagent.history',
  'subagent.prompt',
  'host.pickDirectory',
  'host.listDirectory',
  'host.openPath',
  'agentPreset.openDocument',
  'settings.openDocument',
  'llm.discoverModels',
])

/**
 * `ctx.apiProxy` 的窄化视图。宿主官方实现（ApiProxyService）逐域暴露具名
 * 方法，这里只依赖方法存在，不依赖其内部的 schema 模块。
 */
export interface ApiProxyLike {
  sessions?: Record<string, UnknownMethod>
  subagents?: Record<string, UnknownMethod>
  host?: Record<string, UnknownMethod>
  workspace?: Record<string, UnknownMethod>
  skills?: Record<string, UnknownMethod>
  agentPresets?: Record<string, UnknownMethod>
  goals?: Record<string, UnknownMethod>
  settings?: Record<string, UnknownMethod>
  credentials?: Record<string, UnknownMethod>
  llm?: Record<string, UnknownMethod>
}

type UnknownMethod = (...args: never[]) => Promise<unknown>

/** 网关依赖。 */
export interface GateContext extends AuthLookup {
  config: PluginConfig
  store: StateStore
  /** 宿主 API 网关（`ctx.apiProxy`）。 */
  api: ApiProxyLike
  log: (message: string) => void
}

/** 注册结果。 */
export interface GateHandle {
  dispose: () => void
  /** 实际接管的方法清单（日志 / 自检用）。 */
  methods: readonly string[]
}

/** 精确路由注册函数（`ctx.webServer.register` 的形状）。 */
export type RouteRegistrar = (route: {
  kind: 'exact'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}) => () => void

/**
 * 注册全部影子路由。
 * @param ctx - 网关依赖。
 * @param register - 路由注册函数。
 */
export function registerApiGate(ctx: GateContext, register: RouteRegistrar): GateHandle {
  const methods = [...Object.keys(METHOD_RULES), ...ctx.auth.adminOnlyMethods.filter(
    (method): method is string => typeof method === 'string' && method.length > 0,
  )]
  const unique = [...new Set(methods)]
  const disposers: (() => void)[] = []

  for (const method of unique) {
    const rule: MethodRule = METHOD_RULES[method] ?? { adminOnly: true }
    try {
      disposers.push(register({
        kind: 'exact',
        path: `${API}/${method}`,
        handler: (req, res) => handleMethod(
          ctx,
          method,
          rule,
          req as IncomingMessage,
          res as ServerResponse,
        ),
      }))
    } catch (err) {
      // 注册冲突（例如别的插件抢先注册了同一路径）不应拖垮整个插件。
      ctx.log(`影子化 ${method} 失败：${String(err)}`)
    }
  }

  // session.export 是 GET + query 参数，不走 JSON 信封，单独处理。
  try {
    disposers.push(register({
      kind: 'exact',
      path: `${API}/session.export`,
      handler: (req, res) => handleExport(ctx, req as IncomingMessage, res as ServerResponse),
    }))
  } catch (err) {
    ctx.log(`影子化 session.export 失败：${String(err)}`)
  }

  return {
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
    methods: unique,
  }
}

/* ── 请求处理 ── */

async function handleMethod(
  ctx: GateContext,
  method: string,
  rule: MethodRule,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return text(res, 404, 'not found')

  const principal = principalFromRequest(req, ctx)
  if (principal === undefined) {
    return rpcError(res, '登录状态已失效，请重新登录')
  }
  if (rule.adminOnly === true && principal.role !== 'admin') {
    return rpcError(res, `${method} 需要管理员权限`)
  }

  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') return text(res, 415, 'content type must be application/json')

  const raw = await readBody(req)
  if (raw === undefined) return text(res, 413, 'request body too large')

  const envelope = parseEnvelope(raw)
  if (envelope === undefined || envelope.method !== method) {
    return text(res, 400, 'invalid client-request message')
  }

  if (rule.sessionIdField !== undefined) {
    const sessionId = strOf(envelope.payload, rule.sessionIdField)
    if (sessionId !== undefined && !allowed(ctx, principal, sessionId)) {
      return rpcError(res, '无权访问该会话')
    }
  }

  let result: unknown
  try {
    result = await invoke(ctx, method, { rpcId: envelope.rpcId, payload: envelope.payload }, req, res)
  } catch (err) {
    ctx.log(`${method} 调用失败：${String(err)}`)
    return text(res, 500, `handler failure: ${String(err)}`)
  }

  let body = JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result })
  if (rule.filter === 'session-list') body = filterSessionList(ctx, principal, body)
  else if (rule.filterWorkspace === true) body = filterWorkspaceList(ctx, principal, body)
  else if (rule.claim === true) body = claimCreated(ctx, principal, body)

  return json(res, body)
}

async function handleExport(ctx: GateContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 404, 'not found')
  const principal = principalFromRequest(req, ctx)
  if (principal === undefined) return text(res, 401, 'unauthenticated')
  const sessionId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId')
  if (sessionId !== null && sessionId !== '' && !allowed(ctx, principal, sessionId)) {
    return text(res, 403, 'forbidden')
  }
  ctx.log(`session.export 未接管转发（${sessionId ?? '未知会话'}），交由官方路由处理`)
  return text(res, 501, 'session export is not proxied by user-manager')
}

/**
 * 调用宿主 API 的具名方法。
 * `@deepseek-ai/dsh-host-apiproxy` 不是本插件的依赖，因此不复用它的
 * toFetchHandler，而是按 `域.方法` 直接取方法调用 —— 只依赖方法名稳定。
 */
async function invoke(
  ctx: GateContext,
  method: string,
  request: RpcRequestLike,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown> {
  const dot = method.lastIndexOf('.')
  if (dot <= 0) throw new Error(`unsupported method ${method}`)
  const prefix = method.slice(0, dot)
  const action = method.slice(dot + 1)
  const domain = DOMAIN_OF[prefix]
  if (domain === undefined) throw new Error(`unknown api domain for ${method}`)
  const table = (ctx.api as unknown as Record<string, Record<string, UnknownMethod> | undefined>)[domain]
  const fn = table?.[action]
  if (typeof fn !== 'function') throw new Error(`api method ${method} unavailable`)

  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  req.on('aborted', abort)
  res.on('close', abort)
  try {
    const call = fn as unknown as (
      request: RpcRequestLike,
      signal?: AbortSignal,
    ) => Promise<RpcResponseLike>
    const response = SIGNAL_METHODS.has(method)
      ? await call(request, controller.signal)
      : await call(request)
    return response.result
  } finally {
    req.off('aborted', abort)
    res.off('close', abort)
  }
}

/** 归属判定：拥有者可访问；无主会话按配置的 unownedSessions 策略。 */
function allowed(ctx: GateContext, principal: SessionPrincipal, sessionId: string): boolean {
  const verdict = ctx.store.verdict(sessionId, principal.userId)
  if (verdict === 'owner') return true
  if (verdict === 'other') return false
  // 无主会话：本插件启用前就存在的历史会话，或子代理会话尚未登记。
  return ctx.auth.unownedSessions === 'everyone'
    || (ctx.auth.unownedSessions === 'admin' && principal.role === 'admin')
}

/* ── 响应改写 ── */

/** 过滤 session.list / session.search 的结果。 */
function filterSessionList(ctx: GateContext, principal: SessionPrincipal, body: string): string {
  const parsed = parseJson(body)
  if (parsed === undefined) return body
  const result = asRecord(parsed.result)
  if (result === undefined || result.ok !== true) return body
  const value = asRecord(result.value)
  if (value === undefined || !Array.isArray(value.items)) return body
  value.items = value.items.filter(item => {
    const sessionId = strOf(asRecord(item) ?? {}, 'sessionId')
    return sessionId === undefined || allowed(ctx, principal, sessionId)
  })
  return JSON.stringify(parsed)
}

/** 过滤 workspace.list 的 sessionIds，并隐藏没有可见会话的工作区。 */
function filterWorkspaceList(ctx: GateContext, principal: SessionPrincipal, body: string): string {
  const parsed = parseJson(body)
  if (parsed === undefined) return body
  const result = asRecord(parsed.result)
  if (result === undefined || result.ok !== true) return body
  const value = asRecord(result.value)
  if (value === undefined || !Array.isArray(value.items)) return body
  const items: Record<string, unknown>[] = []
  for (const item of value.items) {
    const row = asRecord(item)
    if (row === undefined) continue
    const ids = Array.isArray(row.sessionIds) ? row.sessionIds : []
    const visible = ids.filter(id => typeof id !== 'string' || allowed(ctx, principal, id))
    if (visible.length === 0) continue
    row.sessionIds = visible
    items.push(row)
  }
  value.items = items
  if (Array.isArray(value.archivedSessionIds)) {
    value.archivedSessionIds = value.archivedSessionIds.filter(
      id => typeof id !== 'string' || allowed(ctx, principal, id),
    )
  }
  return JSON.stringify(parsed)
}

/** session.create 成功后登记归属。 */
function claimCreated(ctx: GateContext, principal: SessionPrincipal, body: string): string {
  const parsed = parseJson(body)
  if (parsed === undefined) return body
  const result = asRecord(parsed.result)
  if (result === undefined || result.ok !== true) return body
  const value = asRecord(result.value)
  const sessionId = value === undefined ? undefined : strOf(value, 'sessionId')
  if (sessionId === undefined) return body
  ctx.store.claim(sessionId, principal.userId)
  ctx.store.save()
  return body
}

/* ── 工具 ── */

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 解析客户端信封；只做形状校验，业务 payload 由宿主实现自行处理。 */
function parseEnvelope(raw: string): { rpcId: string; method: string; payload: Record<string, unknown> } | undefined {
  const parsed = parseJson(raw)
  if (parsed === undefined) return undefined
  if (parsed.type !== 'client-request') return undefined
  if (typeof parsed.rpcId !== 'string' || parsed.rpcId === '') return undefined
  if (typeof parsed.method !== 'string') return undefined
  const payload = parsed.payload
  if (payload !== null && typeof payload !== 'object') return undefined
  return {
    rpcId: parsed.rpcId,
    method: parsed.method,
    payload: (payload ?? {}) as Record<string, unknown>,
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function strOf(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * 业务层拒绝。沿用官方约定：HTTP 状态只表达载体层，业务错误一律 200 +
 * ServerResponse 的错误分支。错误码取 bad-request —— 码表是闭合枚举，
 * 没有 unauthorized，而 internal 在部分客户端会触发重试。
 */
function rpcError(res: ServerResponse, message: string): void {
  json(res, JSON.stringify({
    type: 'server-response',
    rpcId: 'invalid-request',
    result: { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } },
  }))
}

function json(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(body)
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}
