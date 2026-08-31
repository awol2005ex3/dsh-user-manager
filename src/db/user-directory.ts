/**
 * 数据库模式的用户库：SQLite / MySQL / PostgreSQL 三选一，共用一张 users 表。
 */

import { hashPassword, verifyPassword } from '../auth.js'
import type { UserRecord, UserRole, WritableUserDirectory } from '../types.js'
import { createSqlClient, dialectFor, type SqlClient, type SqlRow } from './dialect.js'

/** 用户名规则：字母数字与 . _ - @，3~64 字符。 */
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{3,64}$/

/**
 * 关系型用户库。连接在建表时建立；所有写操作立即生效（无事务包装，
 * 单次语句本身即原子）。
 */
export class DatabaseUserDirectory implements WritableUserDirectory {
  private constructor(
    private readonly client: SqlClient,
    private readonly scryptCost: number,
  ) {}

  /** 建立连接并建表。 */
  static async connect(config: NonNullable<Parameters<typeof createSqlClient>[0]>, scryptCost: number): Promise<DatabaseUserDirectory> {
    const client = await createSqlClient(config)
    return new DatabaseUserDirectory(client, scryptCost)
  }

  async authenticate(username: string, password: string): Promise<UserRecord | null> {
    const row = await this.findByUsername(username)
    if (row === null) return null
    if (bool(row.disabled)) return null
    const stored = str(row.password_hash)
    // 目录托管的账号没有本地口令，只能由目录校验。
    if (stored === undefined || stored === '') return null
    if (!(await verifyPassword(password, stored))) return null
    return toRecord(row)
  }

  async list(): Promise<UserRecord[]> {
    const d = dialectFor(this.client.engine)
    const rows = await this.client.query(
      `SELECT * FROM ${d.quote('users')} ORDER BY ${d.quote('id')} ASC`,
    )
    return rows.map(toRecord)
  }

  async create(input: {
    username: string
    password: string
    displayName?: string
    role?: UserRole
  }): Promise<UserRecord> {
    const username = normalizeUsername(input.username)
    assertPassword(input.password)
    if (await this.findByUsername(username) !== null) {
      throw new Error(`用户名 ${username} 已存在`)
    }
    const d = dialectFor(this.client.engine)
    const hash = await hashPassword(input.password, this.scryptCost)
    const now = new Date().toISOString()
    await this.client.execute(
      `INSERT INTO ${d.quote('users')}
        (${d.quote('username')}, ${d.quote('display_name')}, ${d.quote('password_hash')},
         ${d.quote('role')}, ${d.quote('disabled')}, ${d.quote('source')}, ${d.quote('created_at')})
       VALUES (${d.param(0)}, ${d.param(1)}, ${d.param(2)}, ${d.param(3)}, ${d.param(4)}, ${d.param(5)}, ${d.param(6)})`,
      [
        username,
        input.displayName?.trim() || username,
        hash,
        input.role ?? 'user',
        d.bool(false),
        'database',
        now,
      ],
    )
    const row = await this.findByUsername(username)
    if (row === null) throw new Error('创建用户后读取失败')
    return toRecord(row)
  }

  async update(id: string, patch: {
    displayName?: string
    role?: UserRole
    disabled?: boolean
    password?: string
  }): Promise<UserRecord> {
    const d = dialectFor(this.client.engine)
    const sets: string[] = []
    const params: (string | number | boolean | null)[] = []
    const add = (column: string, value: string | number | boolean | null): void => {
      sets.push(`${d.quote(column)} = ${d.param(params.length)}`)
      params.push(value)
    }
    if (patch.displayName !== undefined) add('display_name', patch.displayName.trim() || id)
    if (patch.role !== undefined) add('role', patch.role)
    if (patch.disabled !== undefined) add('disabled', d.bool(patch.disabled))
    if (patch.password !== undefined) {
      assertPassword(patch.password)
      add('password_hash', await hashPassword(patch.password, this.scryptCost))
    }
    if (sets.length === 0) {
      const row = await this.findById(id)
      if (row === null) throw new Error(`用户 ${id} 不存在`)
      return toRecord(row)
    }
    const whereParam = d.param(params.length)
    params.push(id)
    const changed = await this.client.execute(
      `UPDATE ${d.quote('users')} SET ${sets.join(', ')} WHERE ${d.quote('id')} = ${whereParam}`,
      params,
    )
    if (changed === 0) throw new Error(`用户 ${id} 不存在`)
    const row = await this.findById(id)
    if (row === null) throw new Error(`用户 ${id} 不存在`)
    return toRecord(row)
  }

  async remove(id: string): Promise<void> {
    const d = dialectFor(this.client.engine)
    const changed = await this.client.execute(
      `DELETE FROM ${d.quote('users')} WHERE ${d.quote('id')} = ${d.param(0)}`,
      [id],
    )
    if (changed === 0) throw new Error(`用户 ${id} 不存在`)
  }

  async changePassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
    const row = await this.findById(id)
    if (row === null) throw new Error(`用户 ${id} 不存在`)
    const stored = str(row.password_hash)
    if (stored === undefined || stored === '') throw new Error('该账号由目录服务托管，口令不在本地')
    if (!(await verifyPassword(currentPassword, stored))) throw new Error('当前口令不正确')
    assertPassword(newPassword)
    await this.update(id, { password: newPassword })
  }

  async close(): Promise<void> {
    await this.client.close()
  }

  private async findByUsername(username: string): Promise<SqlRow | null> {
    const d = dialectFor(this.client.engine)
    const rows = await this.client.query(
      `SELECT * FROM ${d.quote('users')} WHERE ${d.quote('username')} = ${d.param(0)}`,
      [username],
    )
    return rows[0] ?? null
  }

  private async findById(id: string): Promise<SqlRow | null> {
    const d = dialectFor(this.client.engine)
    const rows = await this.client.query(
      `SELECT * FROM ${d.quote('users')} WHERE ${d.quote('id')} = ${d.param(0)}`,
      [id],
    )
    return rows[0] ?? null
  }
}

/** 用户名归一化与校验。 */
export function normalizeUsername(raw: string): string {
  const username = raw.trim()
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error('用户名需为 3~64 位字母、数字或 . _ - @')
  }
  return username
}

/** 口令强度校验：只设下限。 */
export function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('口令至少 8 位')
  }
}

function toRecord(row: SqlRow): UserRecord {
  const username = str(row.username) ?? ''
  return {
    id: String(row.id ?? ''),
    username,
    displayName: str(row.display_name) ?? username,
    role: str(row.role) === 'admin' ? 'admin' : 'user',
    disabled: bool(row.disabled),
    source: str(row.source) === 'ldap' ? 'ldap' : 'database',
    createdAt: str(row.created_at) ?? '',
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}
