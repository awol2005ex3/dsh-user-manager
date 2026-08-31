/**
 * `/user-manager/*` 自控路由。走 `ctx.webServer.register` 的原生 HTTP 面 ——
 * 而不是 `connection.rpc.handle`，因为后者只给 `(endpoint, payload, signal)`，
 * 拿不到 Cookie，无法识别调用者。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  issueToken,
  readCookie,
  serializeCookie,
  verifyAdminPassword,
  verifyToken,
} from './auth.js'
import type { AuthLookup } from './session-lookup.js'
import type { AdminCredential } from './config.js'
import { DatabaseUserDirectory, assertPassword, normalizeUsername } from './db/user-directory.js'
import { LdapUserDirectory } from './ldap.js'
import type {
  DatabaseConfig,
  DirectoryMode,
  LdapConfig,
  PluginConfig,
  ResolvedAuthConfig,
  SessionPrincipal,
  UserDirectory,
  UserRecord,
  UserRole,
  WritableUserDirectory,
} from './types.js'

/** 请求体上限：本插件的载荷都很小。 */
const MAX_BODY_BYTES = 64 * 1024

/** 路由依赖。 */
export interface RouteContext {
  config: PluginConfig
  auth: ResolvedAuthConfig
  secret: string
  /** 当前生效的用户目录（切换模式后可替换）。 */
  getDirectory: () => UserDirectory
  /** 页面保存的连接配置（优先于 profile 配置）。 */
  getConnection: () => { mode: DirectoryMode; database?: DatabaseConfig; ldap?: LdapConfig }
  /** 切换目录实现（保存配置后重建）。 */
  switchDirectory: (mode: DirectoryMode, database?: DatabaseConfig, ldap?: LdapConfig) => Promise<void>
  /** 环境变量管理员（本地兜底账号）。 */
  getAdmin: () => AdminCredential | undefined
  /** 登记一次签发，用于后续按用户批量吊销。 */
  track: (jti: string, userId: string, expiresAt: number) => void
  /** 票据是否已被吊销。 */
  isRevoked: (jti: string) => boolean
  /** 让某用户的所有登录态失效。 */
  revokeUser: (userId: string) => void
  log: (message: string) => void
}

/* ── 基础工具 ── */

/** 读取并解析 JSON 请求体；超限或非 JSON 返回 undefined。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** 从请求解析登录主体；无效返回 undefined。 */
export function principalFromRequest(
  req: IncomingMessage,
  ctx: AuthLookup,
): SessionPrincipal | undefined {
  const token = readCookie(req.headers.cookie, ctx.auth.cookieName)
  if (token === undefined) return undefined
  return verifyToken(token, {
    auth: ctx.auth,
    secret: ctx.secret,
    revoked: ctx.isRevoked,
  })
}

function setSessionCookie(res: ServerResponse, ctx: RouteContext, token: string, maxAge: number): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(ctx.auth.cookieName, token, { maxAge, sameSite: ctx.auth.cookieSameSite }),
  )
}

function clearSessionCookie(res: ServerResponse, ctx: RouteContext): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(ctx.auth.cookieName, '', { maxAge: 0, sameSite: ctx.auth.cookieSameSite }),
  )
}

/** 取字符串字段。 */
function strField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' ? value : undefined
}

function boolField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key]
  return typeof value === 'boolean' ? value : undefined
}

/* ── 路由注册 ── */

/** 精确路由注册函数（与 gate.ts 的 RouteRegistrar 同形）。 */
export type RouteRegistrar = (route: {
  kind: 'exact'
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}) => () => void

/** 宿主路由表里 handler 的签名（与 gate.ts 的 unknown 版本同形）。 */
type HostHandler = (req: unknown, res: unknown) => void | Promise<void>

/** 注册 `/user-manager/*`。精确路径，不与 /api 前缀冲突。 */
export function registerUserRoutes(ctx: RouteContext, register: RouteRegistrar): () => void {
  const disposers: (() => void)[] = []
  const mount = (
    path: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  ): void => {
    // 宿主与插件两侧的 handler 形状一致（都是 (req, res)），
    // 类型上的差异只来自声明位置，这里做一次签名桥接。
    disposers.push(register({
      kind: 'exact',
      path,
      handler: handler as unknown as HostHandler,
    }))
  }

  mount('/user-manager/login', async (req, res) => {
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
    const body = await readJsonBody(req)
    if (body === undefined) return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
    const username = strField(body, 'username')?.trim() ?? ''
    const password = strField(body, 'password') ?? ''
    if (username === '' || password === '') {
      return sendJson(res, 400, { ok: false, error: '请填写用户名和密码' })
    }
    const user = await authenticate(ctx, username, password)
    if (user === null) {
      // 不区分"用户不存在"与"口令错误"，避免账号枚举。
      return sendJson(res, 401, { ok: false, error: '用户名或口令不正确' })
    }
    if (user.disabled) return sendJson(res, 403, { ok: false, error: '账号已停用' })
    const { token, principal, jti } = issueToken(
      {
        userId: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        source: user.source,
      },
      ctx.auth,
      ctx.secret,
    )
    ctx.track(jti, user.id, principal.expiresAt)
    setSessionCookie(res, ctx, token, ctx.auth.sessionTtlSeconds)
    return sendJson(res, 200, { ok: true, user: principal })
  })

  mount('/user-manager/logout', async (req, res) => {
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
    const principal = principalFromRequest(req, ctx)
    if (principal !== undefined) ctx.revokeUser(principal.userId)
    clearSessionCookie(res, ctx)
    return sendJson(res, 200, { ok: true })
  })

  mount('/user-manager/me', async (req, res) => {
    if (req.method !== 'GET') return sendText(res, 405, 'method not allowed')
    const principal = principalFromRequest(req, ctx)
    if (principal === undefined) return sendJson(res, 401, { ok: false, error: '未登录' })
    return sendJson(res, 200, {
      ok: true,
      user: principal,
      mode: ctx.getConnection().mode,
      enforce: ctx.config.enforce,
    })
  })

  mount('/user-manager/password', async (req, res) => {
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
    const principal = principalFromRequest(req, ctx)
    if (principal === undefined) return sendJson(res, 401, { ok: false, error: '未登录' })
    const body = await readJsonBody(req)
    if (body === undefined) return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
    const current = strField(body, 'currentPassword') ?? ''
    const next = strField(body, 'newPassword') ?? ''
    const directory = ctx.getDirectory()
    if (!isWritable(directory)) {
      return sendJson(res, 400, { ok: false, error: '当前为用户目录模式，口令由目录服务管理' })
    }
    try {
      assertPassword(next)
      await directory.changePassword(principal.userId, current, next)
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: messageOf(err) })
    }
    ctx.revokeUser(principal.userId)
    return sendJson(res, 200, { ok: true })
  })

  mount('/user-manager/users', async (req, res) => {
    const principal = principalFromRequest(req, ctx)
    if (principal === undefined) return sendJson(res, 401, { ok: false, error: '未登录' })
    if (principal.role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员权限' })
    if (req.method === 'GET') {
      try {
        const users = await ctx.getDirectory().list()
        return sendJson(res, 200, { ok: true, users })
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: messageOf(err) })
      }
    }
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
    const body = await readJsonBody(req)
    if (body === undefined) return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
    const directory = ctx.getDirectory()
    if (!isWritable(directory)) {
      return sendJson(res, 400, { ok: false, error: '目录模式下用户由目录服务维护，不能新建' })
    }
    try {
      const username = normalizeUsername(strField(body, 'username') ?? '')
      const password = strField(body, 'password') ?? ''
      assertPassword(password)
      const created = await directory.create({
        username,
        password,
        ...(strField(body, 'displayName') === undefined
          ? {}
          : { displayName: strField(body, 'displayName') as string }),
        role: strField(body, 'role') === 'admin' ? 'admin' : 'user',
      })
      return sendJson(res, 200, { ok: true, user: created })
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: messageOf(err) })
    }
  })

  mount('/user-manager/user/update', async (req, res) => {
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
    const principal = principalFromRequest(req, ctx)
    if (principal === undefined) return sendJson(res, 401, { ok: false, error: '未登录' })
    if (principal.role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员权限' })
    const body = await readJsonBody(req)
    if (body === undefined) return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
    const id = strField(body, 'id')
    if (id === undefined || id === '') return sendJson(res, 400, { ok: false, error: '缺少 id' })
    const directory = ctx.getDirectory()
    if (!isWritable(directory)) {
      return sendJson(res, 400, { ok: false, error: '目录模式下用户由目录服务维护，不能修改' })
    }
    try {
      const updated = await directory.update(id, {
        ...(strField(body, 'displayName') === undefined
          ? {}
          : { displayName: strField(body, 'displayName') as string }),
        ...(strField(body, 'role') === undefined
          ? {}
          : { role: (strField(body, 'role') === 'admin' ? 'admin' : 'user') as UserRole }),
        ...(boolField(body, 'disabled') === undefined ? {} : { disabled: boolField(body, 'disabled') as boolean }),
        ...(strField(body, 'password') === undefined || (strField(body, 'password') as string) === ''
          ? {}
          : { password: strField(body, 'password') as string }),
      })
      if (boolField(body, 'disabled') === true || strField(body, 'password') !== undefined) {
        ctx.revokeUser(id)
      }
      return sendJson(res, 200, { ok: true, user: updated })
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: messageOf(err) })
    }
  })

  mount('/user-manager/user/delete', async (req, res) => {
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
    const principal = principalFromRequest(req, ctx)
    if (principal === undefined) return sendJson(res, 401, { ok: false, error: '未登录' })
    if (principal.role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员权限' })
    const body = await readJsonBody(req)
    if (body === undefined) return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
    const id = strField(body, 'id')
    if (id === undefined || id === '') return sendJson(res, 400, { ok: false, error: '缺少 id' })
    if (principal.userId === id) return sendJson(res, 400, { ok: false, error: '不能删除当前登录的账号' })
    const directory = ctx.getDirectory()
    if (!isWritable(directory)) {
      return sendJson(res, 400, { ok: false, error: '目录模式下用户由目录服务维护，不能删除' })
    }
    try {
      await directory.remove(id)
      ctx.revokeUser(id)
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: messageOf(err) })
    }
  })

  mount('/user-manager/connection', async (req, res) => {
    const principal = principalFromRequest(req, ctx)
    if (principal === undefined) return sendJson(res, 401, { ok: false, error: '未登录' })
    if (req.method === 'GET') {
      const connection = ctx.getConnection()
      return sendJson(res, 200, {
        ok: true,
        mode: connection.mode,
        database: maskPassword(connection.database),
        ldap: maskLdapPassword(connection.ldap),
        writable: isWritable(ctx.getDirectory()),
      })
    }
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
    if (principal.role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员权限' })
    const body = await readJsonBody(req)
    if (body === undefined) return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
    const mode = strField(body, 'mode') === 'ldap' ? 'ldap' : 'database'
    const database = body.database as DatabaseConfig | undefined
    const ldap = body.ldap as LdapConfig | undefined
    try {
      await ctx.switchDirectory(mode, database, ldap)
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: messageOf(err) })
    }
    return sendJson(res, 200, { ok: true, mode })
  })

  mount('/user-manager/connection/test', async (req, res) => {
    if (req.method !== 'POST') return sendText(res, 405, 'method not allowed')
    const principal = principalFromRequest(req, ctx)
    if (principal === undefined) return sendJson(res, 401, { ok: false, error: '未登录' })
    if (principal.role !== 'admin') return sendJson(res, 403, { ok: false, error: '需要管理员权限' })
    const body = await readJsonBody(req)
    if (body === undefined) return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON' })
    const mode = strField(body, 'mode') === 'ldap' ? 'ldap' : 'database'
    try {
      if (mode === 'ldap') {
        const config = body.ldap as LdapConfig | undefined
        if (config === undefined) return sendJson(res, 400, { ok: false, error: '缺少 ldap 配置' })
        const result = await new LdapUserDirectory(config).testConnection()
        return sendJson(res, 200, { ...result, ok: true })
      }
      const config = body.database as DatabaseConfig | undefined
      if (config === undefined) return sendJson(res, 400, { ok: false, error: '缺少 database 配置' })
      const probe = await DatabaseUserDirectory.connect(config, ctx.auth.scryptCost)
      const users = await probe.list()
      await probe.close()
      return sendJson(res, 200, { ok: true, users: users.length })
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: messageOf(err) })
    }
  })

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * 认证入口：先查用户目录，未命中再回落环境变量管理员。
 * 管理员是本地兜底账号，用于目录还没配好或目录不可用时的最后一扇门。
 */
async function authenticate(
  ctx: RouteContext,
  username: string,
  password: string,
): Promise<UserRecord | null> {
  try {
    const user = await ctx.getDirectory().authenticate(username, password)
    if (user !== null) return user
  } catch (err) {
    ctx.log(`目录认证失败：${messageOf(err)}`)
  }
  return authenticateAdmin(ctx, username, password)
}

/** 环境变量管理员兜底认证。 */
async function authenticateAdmin(
  ctx: RouteContext,
  username: string,
  password: string,
): Promise<UserRecord | null> {
  const admin = ctx.getAdmin()
  if (admin === undefined || admin.username.toLowerCase() !== username.toLowerCase()) return null
  if (!(await verifyAdminPassword(admin, password))) return null
  return {
    id: `env:${admin.username}`,
    username: admin.username,
    displayName: admin.username,
    role: 'admin',
    disabled: false,
    source: 'database',
    createdAt: '',
  }
}

function isWritable(directory: UserDirectory): directory is WritableUserDirectory {
  return typeof (directory as WritableUserDirectory).create === 'function'
}

function maskPassword(database: DatabaseConfig | undefined): DatabaseConfig | undefined {
  if (database === undefined) return undefined
  return { ...database, ...(database.password === undefined ? {} : { password: '' }) }
}

function maskLdapPassword(ldap: LdapConfig | undefined): LdapConfig | undefined {
  if (ldap === undefined) return undefined
  return { ...ldap, ...(ldap.bindPassword === undefined ? {} : { bindPassword: '' }) }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
