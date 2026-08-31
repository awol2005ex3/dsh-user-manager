/**
 * 口令哈希与登录态。口令用 scrypt（node 内置，无需外部依赖）；登录态是
 * HMAC-SHA256 签名的无状态票据，服务端同时保留一份内存副本以便吊销（登出、
 * 删除用户、改口令）。
 */

import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import type { AdminCredential } from './config.js'
import type { ResolvedAuthConfig, SessionPrincipal, UserRole, UserSource } from './types.js'

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

/** 与 config 默认值保持一致；scrypt 的 N 必须是 2 的幂。 */
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64

/**
 * 生成口令哈希。产物形如 `scrypt$N$r$p$saltB64$hashB64`，自带全部参数，
 * 后续调整 cost 不影响老哈希校验。
 */
export async function hashPassword(password: string, cost: number): Promise<string> {
  const n = normalizeCost(cost)
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEY_LENGTH, {
    N: n,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * n * SCRYPT_R * 2,
  })
  return [
    'scrypt',
    n,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

/** 校验明文口令与哈希是否匹配；哈希格式非法一律判为不匹配。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, nRaw, rRaw, pRaw, saltB64, keyB64] = parts as [
    string, string, string, string, string, string,
  ]
  const n = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || n <= 1 || r <= 0 || p <= 0) {
    return false
  }
  try {
    const expected = Buffer.from(keyB64, 'base64')
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: n,
      r,
      p,
      maxmem: 256 * n * r * 2,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function normalizeCost(cost: number): number {
  if (!Number.isFinite(cost) || cost < 2) return 16_384
  const rounded = 2 ** Math.round(Math.log2(cost))
  return Math.min(Math.max(rounded, 2 ** 10), 2 ** 20)
}

/** 票据明文部分（签名前）。 */
interface TokenPayload extends SessionPrincipal {
  /** 票据 id，用于服务端吊销。 */
  jti: string
}

/** 登录态票据：<base64url(payload)>.<base64url(hmac)>。 */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

/** 签发一张登录态票据。 */
export function issueToken(
  input: { userId: string; username: string; displayName: string; role: UserRole; source: UserSource },
  auth: ResolvedAuthConfig,
  secret: string,
): { token: string; principal: SessionPrincipal; jti: string } {
  const now = Date.now()
  const jti = randomBytes(16).toString('base64url')
  const payload: TokenPayload = {
    userId: input.userId,
    username: input.username,
    displayName: input.displayName,
    role: input.role,
    source: input.source,
    expiresAt: now + auth.sessionTtlSeconds * 1000,
    jti,
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return {
    token: `${body}.${sign(body, secret)}`,
    principal: {
      userId: payload.userId,
      username: payload.username,
      displayName: payload.displayName,
      role: payload.role,
      source: payload.source,
      expiresAt: payload.expiresAt,
    },
    jti,
  }
}

/** 校验票据签名、有效期与吊销状态；任一不满足返回 undefined。 */
export function verifyToken(
  token: string,
  opts: { auth: ResolvedAuthConfig; secret: string; revoked: (jti: string) => boolean },
): SessionPrincipal | undefined {
  const dot = token.indexOf('.')
  if (dot <= 0) return undefined
  const body = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  const expected = sign(body, opts.secret)
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(signature, 'utf8')
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return undefined
  }
  let payload: TokenPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload
  } catch {
    return undefined
  }
  if (typeof payload?.jti !== 'string' || typeof payload.userId !== 'string') return undefined
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) return undefined
  if (opts.revoked(payload.jti)) return undefined
  return {
    userId: payload.userId,
    username: payload.username,
    displayName: payload.displayName,
    role: payload.role === 'admin' ? 'admin' : 'user',
    source: payload.source === 'ldap' ? 'ldap' : 'database',
    expiresAt: payload.expiresAt,
  }
}

/**
 * 已吊销票据登记表。除了逐张登记，还维护"用户 → 已签发票据"索引，
 * 以便改口令 / 停用 / 删除用户时把这个人的所有登录态一次性踢下线。
 */
export class RevocationList {
  private readonly revoked = new Map<string, number>()
  private readonly byUser = new Map<string, Set<string>>()

  /** 登记一次签发（用于后续按用户批量吊销）。 */
  track(jti: string, userId: string, expiresAt: number): void {
    const set = this.byUser.get(userId)
    if (set === undefined) this.byUser.set(userId, new Set([jti]))
    else set.add(jti)
    // 顺带记住过期时间，sweep 时统一清理。
    this.revoked.set(`ttl:${jti}`, expiresAt)
  }

  /** 吊销单张票据（登出）。 */
  add(jti: string, expiresAt: number): void {
    this.revoked.set(jti, expiresAt)
  }

  /** 吊销某用户的全部票据。 */
  addUser(userId: string, expiresAt: number): void {
    const set = this.byUser.get(userId)
    if (set === undefined) return
    for (const jti of set) this.revoked.set(jti, expiresAt)
    set.clear()
    this.byUser.delete(userId)
  }

  /** 某票据是否已被吊销。 */
  has(jti: string): boolean {
    return this.revoked.has(jti)
  }

  /** 清掉已过期的登记项，避免无界增长。 */
  sweep(): void {
    const now = Date.now()
    for (const [key, expiresAt] of this.revoked) {
      if (expiresAt <= now) this.revoked.delete(key)
    }
  }
}

/** 从 Cookie 头取出指定项。 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header === '') return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

/** 生成 Set-Cookie 头值（不含 Set-Cookie 前缀）。 */
export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; sameSite: 'lax' | 'strict'; path?: string },
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`]
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`)
  parts.push(`SameSite=${opts.sameSite === 'strict' ? 'Strict' : 'Lax'}`, 'HttpOnly')
  return parts.join('; ')
}

/**
 * 校验环境变量管理员的口令。同时支持明文与 scrypt 哈希
 * （`scrypt$N$r$p$salt$key` 或 hex 的 `salt:key`）。
 */
export async function verifyAdminPassword(admin: AdminCredential, password: string): Promise<boolean> {
  if (admin.passwordHash !== undefined && admin.passwordHash !== '') {
    if (admin.passwordHash.includes('$')) return verifyPassword(password, admin.passwordHash)
    // `salt:key` 简写：沿用默认参数重算。
    const [salt, key] = splitOnce(admin.passwordHash, ':')
    if (salt === undefined || key === undefined) return false
    try {
      const expected = Buffer.from(key, 'hex')
      const actual = await scrypt(password, Buffer.from(salt, 'hex'), expected.length, {
        N: 16_384,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: 256 * 16_384 * SCRYPT_R * 2,
      })
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    } catch {
      return false
    }
  }
  if (admin.password === undefined) return false
  const a = Buffer.from(admin.password, 'utf8')
  const b = Buffer.from(password, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function splitOnce(value: string, sep: string): [string | undefined, string | undefined] {
  const at = value.indexOf(sep)
  return at < 0 ? [undefined, undefined] : [value.slice(0, at), value.slice(at + sep.length)]
}
