/**
 * 部署配置。浏览器半不引入本文件，所需结构在 client.ts 内联。
 */

import Schema from '@deepseek-ai/schemastery'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { AuthConfig, PluginConfig, ResolvedAuthConfig } from './types.js'

/** 与 harness `packages/util/home-paths` 一致的单根数据目录环境变量。 */
export const DSH_HOME_ENV = 'DSH_HOME'
export const DSH_HOME_DIR_NAME = '.dsh'

/** 管理员账号的环境变量名（只读来源，不落盘）。 */
export const ENV_ADMIN_USERNAME = 'DSH_ADMIN_USERNAME'
export const ENV_ADMIN_PASSWORD = 'DSH_ADMIN_PASSWORD'
export const ENV_ADMIN_PASSWORD_HASH = 'DSH_ADMIN_PASSWORD_HASH'
/** 登录态签名密钥；缺省时进程启动时随机生成（重启后需重新登录）。 */
export const ENV_SESSION_SECRET = 'DSH_SESSION_SECRET'

/** 解析 harness 单根数据目录：显式配置 > `$DSH_HOME` > `~/.dsh`。 */
export function resolveDshHome(configured?: string): string {
  const fromEnv = process.env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : joinDefaultHome())
  return resolve(expandHome(selected))
}

function joinDefaultHome(): string {
  return `${homedir()}/${DSH_HOME_DIR_NAME}`
}

/** 展开 `~` / `~/` 前缀。 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return `${homedir()}/${path.slice(2)}`
  return path
}

/**
 * 数据库配置与 LDAP 配置做成两个可选对象：schemastery 的 object 分支没有
 * 判别式联动，无法按 mode 动态显隐字段，因此改为扁平声明 + apply 内做
 * 模式相关必填校验（见 validateConfig）。
 */
export const Config = Schema.object({
  mode: Schema.union(['database', 'ldap'] as const).default('database').description(
    '用户来源：database 为本地用户表，ldap 为目录服务。',
  ),
  database: Schema.object({
    engine: Schema.union(['sqlite', 'mysql', 'postgres'] as const).default('sqlite').description(
      '数据库引擎。sqlite 开箱即用；mysql / postgres 需对应驱动可选依赖。',
    ),
    filename: Schema.string().description('sqlite 专用：数据库文件路径（相对路径按 DSH_HOME 解析）。'),
    host: Schema.string().description('mysql / postgres：主机。'),
    port: Schema.number().description('mysql / postgres：端口（留空用 3306 / 5432）。'),
    database: Schema.string().description('mysql / postgres：库名。'),
    user: Schema.string().description('mysql / postgres：账号。'),
    password: Schema.string().role('secret').description('mysql / postgres：口令。'),
    ssl: Schema.boolean().description('mysql / postgres：使用 SSL 连接。'),
    schema: Schema.string().description('建表所在的 schema（可选）。'),
  }).description('数据库模式的连接设置，页面可配置并落盘。'),
  ldap: Schema.object({
    url: Schema.string().description('目录地址，形如 ldap://host:389 或 ldaps://host:636。'),
    bindDn: Schema.string().description('用于搜索用户的管理员 DN；留空则尝试匿名绑定。'),
    bindPassword: Schema.string().role('secret').description('绑定口令，与 bindDn 成对。'),
    searchBase: Schema.string().description('用户条目基准 DN。'),
    searchFilter: Schema.string().default('(sAMAccountName={username})').description(
      '登录名过滤模板，必须含 {username}；AD 常用 (sAMAccountName={username})，OpenLDAP 常用 (uid={username})。',
    ),
    displayNameAttribute: Schema.string().description('显示名属性，缺省回落到登录名。'),
    adminDns: Schema.array(Schema.string()).description('映射为管理员的条目 DN 列表（精确匹配）。'),
    tlsRejectUnauthorized: Schema.boolean().default(true).description('校验目录证书；自签内网证书可关闭。'),
    timeoutMs: Schema.number().default(10_000).description('连接与搜索超时（毫秒）。'),
  }).description('LDAP 模式的连接与映射设置，页面可配置并落盘。'),
  auth: Schema.object({
    sessionTtlSeconds: Schema.number().default(60 * 60 * 12).description('登录态有效期（秒）。'),
    cookieName: Schema.string().default('dsh_user').description('登录态 cookie 名。'),
    cookieSameSite: Schema.union(['lax', 'strict'] as const).default('lax').description('cookie 的 SameSite 策略。'),
    scryptCost: Schema.number().default(16_384).description('口令哈希的 scrypt cost（2 的幂）。'),
    unownedSessions: Schema.union(['admin', 'everyone', 'none'] as const).default('admin').description(
      '未被认领的历史会话如何处置：admin 仅管理员可见，everyone 所有人可见，none 任何人都看不到。',
    ),
    adminOnlyMethods: Schema.array(Schema.string()).description('额外限定管理员才能调用的 /api 方法。'),
  }).description('登录态与口令策略。'),
  enforce: Schema.boolean().default(true).description('启用 /api 方法鉴权与会话隔离；关闭后仅提供用户管理。'),
})

/** 鉴权设置的默认值（config 里 auth 为 Partial）。 */
export const DEFAULT_AUTH: ResolvedAuthConfig = {
  sessionTtlSeconds: 60 * 60 * 12,
  cookieName: 'dsh_user',
  cookieSameSite: 'lax',
  scryptCost: 16_384,
  unownedSessions: 'admin',
  adminOnlyMethods: [],
}

/** 合并出完整鉴权设置。 */
export function resolveAuth(auth: Partial<AuthConfig> | undefined): ResolvedAuthConfig {
  return {
    sessionTtlSeconds: auth?.sessionTtlSeconds ?? DEFAULT_AUTH.sessionTtlSeconds,
    cookieName: auth?.cookieName ?? DEFAULT_AUTH.cookieName,
    cookieSameSite: auth?.cookieSameSite ?? DEFAULT_AUTH.cookieSameSite,
    scryptCost: auth?.scryptCost ?? DEFAULT_AUTH.scryptCost,
    unownedSessions: auth?.unownedSessions ?? DEFAULT_AUTH.unownedSessions,
    adminOnlyMethods: auth?.adminOnlyMethods ?? DEFAULT_AUTH.adminOnlyMethods,
  }
}

/**
 * 内置的管理员专属方法（叠加在配置之上）：涉及宿主全局配置与本机副作用，
 * 普通用户不应触达。
 */
export const BUILTIN_ADMIN_ONLY_METHODS: readonly string[] = [
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'settings.openDocument',
  'credentials.set',
  'credentials.unset',
  'credentials.describe',
  'host.openPath',
  'host.createDirectory',
  'agentPreset.remove',
  'agentPreset.copy',
  'agentPreset.openDocument',
]

/**
 * 按 mode 校验必填项。schemastery 的 object 分支无法表达判别式必填，
 * 所以在 apply 入口显式校验，缺项给出可读错误而不是运行期炸在驱动里。
 * @throws 配置不完整时抛出带字段名的错误。
 */
export function validateConfig(config: PluginConfig): void {
  if (config.mode === 'database') {
    const db = config.database
    if (db === undefined) {
      throw new Error('dsh-user-manager: mode=database 需要配置 database 连接信息')
    }
    if (db.engine === 'sqlite') {
      if (db.filename === undefined || db.filename.trim() === '') {
        throw new Error('dsh-user-manager: sqlite 需要 database.filename')
      }
    } else {
      const missing = (['host', 'database', 'user'] as const).filter(field => {
        const value = db[field]
        return value === undefined || String(value).trim() === ''
      })
      if (missing.length > 0) {
        throw new Error(`dsh-user-manager: ${db.engine} 需要 database.${missing.join('、database.')}`)
      }
    }
    return
  }
  const ldap = config.ldap
  if (ldap === undefined) throw new Error('dsh-user-manager: mode=ldap 需要配置 ldap 连接信息')
  if (ldap.url === undefined || ldap.url.trim() === '') throw new Error('dsh-user-manager: ldap.url 必填')
  if (ldap.searchBase === undefined || ldap.searchBase.trim() === '') {
    throw new Error('dsh-user-manager: ldap.searchBase 必填')
  }
  if (ldap.searchFilter !== undefined && !ldap.searchFilter.includes('{username}')) {
    throw new Error('dsh-user-manager: ldap.searchFilter 必须包含 {username} 占位符')
  }
}

/** 管理员凭据（仅来自环境变量，永不写入配置文件）。 */
export interface AdminCredential {
  username: string
  /** 明文口令或 scrypt 哈希，二选一。 */
  password?: string
  passwordHash?: string
}

/** 读取环境变量里的管理员账号；未设置返回 undefined（此时无本地管理员兜底）。 */
export function readAdminCredential(): AdminCredential | undefined {
  const username = process.env[ENV_ADMIN_USERNAME]?.trim()
  if (username === undefined || username === '') return undefined
  const password = process.env[ENV_ADMIN_PASSWORD]
  const passwordHash = process.env[ENV_ADMIN_PASSWORD_HASH]?.trim()
  if ((password === undefined || password === '') && passwordHash === undefined) return undefined
  return {
    username,
    ...(password === undefined ? {} : { password }),
    ...(passwordHash === undefined || passwordHash === '' ? {} : { passwordHash }),
  }
}

/** 登录态签名密钥；缺省随机生成（重启后已发 cookie 失效，需重新登录）。 */
export function readSessionSecret(): string {
  const fromEnv = process.env[ENV_SESSION_SECRET]
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : randomSecret()
}

function randomSecret(): string {
  return randomBytes(32).toString('hex')
}
