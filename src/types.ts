/**
 * 共享类型与插件配置接口。宿主半与插件内部共用；浏览器半不引入本文件
 * （client.ts 刻意无 import，所需类型在其内部重复声明）。
 */

/** 用户角色。`admin` 只能做用户管理，看不到他人会话。 */
export type UserRole = 'admin' | 'user'

/** 用户来源：本地数据库账号，或 LDAP 目录条目。 */
export type UserSource = 'database' | 'ldap'

/** 一条用户记录（对外投影，永不含口令凭据）。 */
export interface UserRecord {
  /** 稳定唯一 id（数据库模式为自增/雪花，LDAP 模式为 `ldap:` + DN 摘要）。 */
  id: string
  /** 登录名。 */
  username: string
  /** 显示名。 */
  displayName: string
  role: UserRole
  /** 停用用户无法登录，但记录保留。 */
  disabled: boolean
  source: UserSource
  createdAt: string
}

/** 数据库模式的连接设置。三选一；连接信息由页面配置并落盘到 state 文件。 */
export interface DatabaseConfig {
  engine: 'sqlite' | 'mysql' | 'postgres'
  /** sqlite 专用：数据库文件路径（相对路径按 DSH_HOME 解析）。 */
  filename?: string
  /** mysql / postgres：主机。 */
  host?: string
  /** mysql / postgres：端口（省略用引擎默认值 3306 / 5432）。 */
  port?: number
  /** mysql / postgres：库名。 */
  database?: string
  /** mysql / postgres：账号。 */
  user?: string
  /** mysql / postgres：口令。 */
  password?: string
  /** postgres / mysql：SSL。 */
  ssl?: boolean
  /** 建表所在 schema（可选，默认引擎缺省 schema）。 */
  schema?: string
}

/** LDAP 模式的连接与映射设置。 */
export interface LdapConfig {
  /** 形如 ldap://host:389 或 ldaps://host:636。 */
  url: string
  /** 用于搜索用户的管理员 DN；留空则尝试匿名绑定搜索。 */
  bindDn?: string
  /** 绑定口令，与 bindDn 成对。 */
  bindPassword?: string
  /** 用户条目基准 DN。 */
  searchBase: string
  /**
   * 登录名 → 条目的过滤模板，必须含 `{username}` 占位符。
   * 例：`(sAMAccountName={username})`（AD）或 `(uid={username})`（OpenLDAP）。
   */
  searchFilter: string
  /** 显示名取自哪个属性；缺省回落到登录名。 */
  displayNameAttribute?: string
  /** 映射为 admin 的条目 DN 列表（精确匹配）。 */
  adminDns?: string[]
  /** 底层 TLS 校验开关；自签证书的内网目录可关闭。 */
  tlsRejectUnauthorized?: boolean
  /** 连接超时（毫秒）。 */
  timeoutMs?: number
}

/** 鉴权与会话设置。 */
export interface AuthConfig {
  /** 登录态有效期（秒）。 */
  sessionTtlSeconds: number
  /** 登录态 cookie 名。 */
  cookieName: string
  /** cookie 的 SameSite 策略。 */
  cookieSameSite: 'lax' | 'strict'
  /** 口令哈希的 scrypt cost 参数。 */
  scryptCost: number
  /**
   * 未被任何用户认领的历史会话如何处置：
   * `admin`（默认）仅管理员可见，`everyone` 所有人可见，`none` 任何人都看不到。
   */
  unownedSessions: 'admin' | 'everyone' | 'none'
  /** 额外禁止普通用户调用的 /api 方法（管理员不受限）。 */
  adminOnlyMethods: string[]
}

/** 用户库模式。 */
export type DirectoryMode = 'database' | 'ldap'

/** 插件配置（经 schemastery 校验）。 */
export interface PluginConfig {
  mode: DirectoryMode
  database?: DatabaseConfig
  ldap?: LdapConfig
  auth?: Partial<AuthConfig>
  /** 是否启用 /api 方法鉴权。关闭后插件只提供用户管理，不做隔离。 */
  enforce: boolean
}

/** 解析后的完整鉴权设置（默认值已填充）。 */
export type ResolvedAuthConfig = Required<AuthConfig>

/** 登录成功后写入的会话主体。 */
export interface SessionPrincipal {
  /** 用户 id。 */
  userId: string
  username: string
  displayName: string
  role: UserRole
  source: UserSource
  /** 过期时间（epoch 毫秒）。 */
  expiresAt: number
}

/** 用户目录适配器：两种模式（database / ldap）的共同契约。 */
export interface UserDirectory {
  /** 校验凭据；成功返回用户，失败返回 null。 */
  authenticate(username: string, password: string): Promise<UserRecord | null>
  /** 列出全部用户（管理与归属展示用）。 */
  list(): Promise<UserRecord[]>
  /** 关闭底层连接（HMR / 卸载时调用）。 */
  close(): Promise<void>
}

/** 用户库专用的写操作（数据库模式实现；LDAP 为只读目录）。 */
export interface WritableUserDirectory extends UserDirectory {
  create(input: {
    username: string
    password: string
    displayName?: string
    role?: UserRole
  }): Promise<UserRecord>
  update(id: string, patch: {
    displayName?: string
    role?: UserRole
    disabled?: boolean
    password?: string
  }): Promise<UserRecord>
  remove(id: string): Promise<void>
  /** 修改自身口令。 */
  changePassword(id: string, currentPassword: string, newPassword: string): Promise<void>
}
