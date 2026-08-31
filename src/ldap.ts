/**
 * LDAP 模式的用户目录：只读映射。
 *
 * 认证走标准两段式 —— 服务账号搜索出 DN，再用该 DN 绑定校验口令
 * （不比对属性，兼容 AD / OpenLDAP 的各种口令存储方式）。
 * 目录里的用户由目录管理员维护，本插件不写目录，因此不实现写操作。
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import type { LdapConfig, UserDirectory, UserRecord } from './types.js'

const require = createRequire(import.meta.url)

/** ldapts 在本项目里是可选依赖，按需加载。 */
interface LdaptsModule {
  Client: new (options: {
    url: string
    timeout?: number
    connectTimeout?: number
    tlsOptions?: { rejectUnauthorized?: boolean }
  }) => LdapClient
  escapeFilter?: (value: string) => string
}

interface LdapClient {
  bind(dn: string, password?: string): Promise<void>
  search(baseDn: string, options: {
    scope?: 'base' | 'one' | 'sub'
    filter: string
    attributes?: string[]
    sizeLimit?: number
  }): Promise<{ searchEntries: LdapEntry[] }>
  unbind(): Promise<void>
}

interface LdapEntry {
  dn: string
  /** 属性名 → 值列表；属性名大小写不敏感，取值时统一按小写比对。 */
  attributes?: Record<string, string[] | string>
  pojo?: {
    attributes?: { type?: string; values?: string[] }[]
  }
}

/** 每次操作都新建连接：LDAP 会话有绑定状态，复用需要小心重置绑定。 */
async function loadLdapts(): Promise<LdaptsModule> {
  try {
    return require('ldapts') as LdaptsModule
  } catch {
    throw new Error(
      'dsh-user-manager: 缺少 LDAP 客户端 ldapts，请在 dsh 的 node_modules 中安装：npm install ldapts',
    )
  }
}

/** RFC 4515 过滤值转义（ldapts 未导出时兜底）。 */
function escapeFilterValue(value: string): string {
  return value
    .replace(/\\/g, '\\5c')
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29')
    .replace(/\0/g, '\\00')
}

/**
 * LDAP 用户目录（只读）。
 */
export class LdapUserDirectory implements UserDirectory {
  constructor(private readonly config: LdapConfig) {}

  /** 连接设置自检：绑定并跑一次搜索，返回命中条目数。 */
  async testConnection(): Promise<{ ok: true; entries: number }> {
    const { Client } = await loadLdapts()
    const client = this.open(Client)
    try {
      await this.bindService(client)
      const result = await client.search(this.config.searchBase, {
        scope: 'sub',
        filter: this.listFilter(),
        attributes: ['dn'],
        sizeLimit: 1,
      })
      return { ok: true, entries: result.searchEntries.length }
    } finally {
      await safeUnbind(client)
    }
  }

  /** 试搜一个具体登录名，用于页面验证过滤模板是否写对。 */
  async testUser(username: string): Promise<{ found: boolean; dn?: string; displayName?: string }> {
    const { Client } = await loadLdapts()
    const client = this.open(Client)
    try {
      await this.bindService(client)
      const entry = await this.findOne(client, username)
      if (entry === undefined) return { found: false }
      return {
        found: true,
        dn: entry.dn,
        ...(this.readDisplayName(entry) === undefined
          ? {}
          : { displayName: this.readDisplayName(entry) as string }),
      }
    } finally {
      await safeUnbind(client)
    }
  }

  async authenticate(username: string, password: string): Promise<UserRecord | null> {
    if (username.trim() === '' || password === '') return null
    const { Client } = await loadLdapts()
    const client = this.open(Client)
    try {
      await this.bindService(client)
      const entry = await this.findOne(client, username)
      if (entry === undefined) return null
      // 用查到的 DN 绑定：口令校验完全交给目录。空口令直接判失败，
      // 因为部分目录对空口令的匿名绑定会意外成功。
      await client.bind(entry.dn, password)
      return this.toRecord(entry)
    } catch {
      // 无效凭据、连接失败、超时都归为登录失败。
      return null
    } finally {
      await safeUnbind(client)
    }
  }

  async list(): Promise<UserRecord[]> {
    const { Client } = await loadLdapts()
    const client = this.open(Client)
    try {
      await this.bindService(client)
      const result = await client.search(this.config.searchBase, {
        scope: 'sub',
        filter: this.listFilter(),
        attributes: this.requestedAttributes(),
        sizeLimit: 1000,
      })
      return result.searchEntries.map(entry => this.toRecord(entry))
    } finally {
      await safeUnbind(client)
    }
  }

  async close(): Promise<void> {
    // 每操作一连接，无长连接池需要关闭。
  }

  private open(Client: LdaptsModule['Client']): LdapClient {
    return new Client({
      url: this.config.url,
      timeout: this.config.timeoutMs ?? 10_000,
      connectTimeout: this.config.timeoutMs ?? 10_000,
      tlsOptions: { rejectUnauthorized: this.config.tlsRejectUnauthorized !== false },
    })
  }

  /** 服务账号绑定；未配置则匿名绑定（部分目录允许匿名搜索）。 */
  private async bindService(client: LdapClient): Promise<void> {
    const dn = this.config.bindDn
    if (dn === undefined || dn.trim() === '') {
      await client.bind('')
      return
    }
    await client.bind(dn, this.config.bindPassword ?? '')
  }

  /** 按登录名取唯一条目；多条命中取第一条（目录本身应保证唯一）。 */
  private async findOne(client: LdapClient, username: string): Promise<LdapEntry | undefined> {
    const filter = this.config.searchFilter.replace(
      /\{username\}/g,
      escapeFilterValue(username.trim()),
    )
    const result = await client.search(this.config.searchBase, {
      scope: 'sub',
      filter,
      attributes: this.requestedAttributes(),
      sizeLimit: 10,
    })
    return result.searchEntries[0]
  }

  /** 列全部用户：把登录名占位符换成通配符，已含通配符则原样使用。 */
  private listFilter(): string {
    const filter = this.config.searchFilter
    if (!filter.includes('{username}')) return filter
    return filter.replace(/\{username\}/g, '*')
  }

  private requestedAttributes(): string[] {
    const attributes = ['dn', 'objectClass']
    const display = this.config.displayNameAttribute?.trim()
    if (display !== undefined && display !== '' && !attributes.includes(display)) {
      attributes.push(display)
    }
    return attributes
  }

  private readDisplayName(entry: LdapEntry): string | undefined {
    const attribute = this.config.displayNameAttribute?.trim()
    if (attribute === undefined || attribute === '') return undefined
    return firstValue(entry, attribute)
  }

  private toRecord(entry: LdapEntry): UserRecord {
    const username = this.usernameFromDn(entry)
    const displayName = this.readDisplayName(entry) ?? username
    return {
      id: `ldap:${sha256(entry.dn).slice(0, 32)}`,
      username,
      displayName,
      role: this.config.adminDns?.includes(entry.dn) === true ? 'admin' : 'user',
      disabled: false,
      source: 'ldap',
      createdAt: '',
    }
  }

  /**
   * 用户名回推：多数目录的用户名可从 RDN 取到。没有可靠属性时用 RDN 的值，
   * 再不行退回 DN 本身。
   */
  private usernameFromDn(entry: LdapEntry): string {
    const rdn = entry.dn.split(',')[0] ?? entry.dn
    const eq = rdn.indexOf('=')
    return eq >= 0 ? rdn.slice(eq + 1).trim() : rdn.trim()
  }
}

/** 取某属性第一个值；命中 displayName 等常见回退属性。 */
function firstValue(entry: LdapEntry, attribute: string): string | undefined {
  const wanted = attribute.toLowerCase()
  const direct = entry.attributes
  if (direct !== undefined) {
    for (const [key, value] of Object.entries(direct)) {
      if (key.toLowerCase() !== wanted) continue
      const first = Array.isArray(value) ? value[0] : value
      if (typeof first === 'string' && first !== '') return first
      return undefined
    }
  }
  const attributes = entry.pojo?.attributes ?? []
  for (const item of attributes) {
    const type = item.type?.toLowerCase()
    if (type !== wanted) continue
    const first = item.values?.[0]
    if (typeof first === 'string' && first !== '') return first
    return undefined
  }
  return undefined
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

async function safeUnbind(client: LdapClient): Promise<void> {
  try {
    await client.unbind()
  } catch {
    // 连接已断开时 unbind 会抛；认证流程不关心。
  }
}
