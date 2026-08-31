/**
 * SQL 方言差异与懒加载连接池。
 *
 * 三种引擎的差异只有三处：标识符引号、占位符、布尔字面量。驱动本身是
 * optionalDependencies —— 用到哪个引擎才 require 哪个，缺驱动时给出可操作的
 * 安装提示而不是栈回溯。
 */

import { createRequire } from 'node:module'
import { resolve as resolvePath } from 'node:path'
import { resolveDshHome } from '../config.js'
import type { DatabaseConfig } from '../types.js'

const require = createRequire(import.meta.url)

/** 一行查询结果（列名 → 值）。 */
export type SqlRow = Record<string, unknown>
export type SqlParam = string | number | boolean | null

/** 统一的查询面。 */
export interface SqlClient {
  readonly engine: DatabaseConfig['engine']
  query(sql: string, params?: readonly SqlParam[]): Promise<SqlRow[]>
  execute(sql: string, params?: readonly SqlParam[]): Promise<number>
  close(): Promise<void>
}

/** 方言差异。 */
export interface SqlDialect {
  quote(identifier: string): string
  param(index: number): string
  bool(value: boolean): SqlParam
}

const DIALECTS: Record<DatabaseConfig['engine'], SqlDialect> = {
  sqlite: {
    quote: id => `"${id.replace(/"/g, '""')}"`,
    param: () => '?',
    bool: value => (value ? 1 : 0),
  },
  mysql: {
    quote: id => `\`${id.replace(/`/g, '``')}\``,
    param: () => '?',
    bool: value => (value ? 1 : 0),
  },
  postgres: {
    quote: id => `"${id.replace(/"/g, '""')}"`,
    param: index => `$${index + 1}`,
    bool: value => value,
  },
}

/** 补齐引擎默认端口。 */
function defaultPort(engine: DatabaseConfig['engine']): number {
  return engine === 'mysql' ? 3306 : 5432
}

/** 缺驱动时的统一报错。 */
function missingDriver(engine: string, pkg: string): never {
  throw new Error(
    `dsh-user-manager: 缺少 ${engine} 驱动 ${pkg}，请在 dsh 的 node_modules 中安装：npm install ${pkg}`,
  )
}

/**
 * 打开连接池并建表。
 * @param config - 页面或 profile 提供的连接设置，sqlite 的相对路径按 DSH_HOME 解析。
 */
export async function createSqlClient(config: DatabaseConfig): Promise<SqlClient> {
  const client = await openClient(config)
  await ensureSchema(client)
  return client
}

async function openClient(config: DatabaseConfig): Promise<SqlClient> {
  if (config.engine === 'sqlite') {
    const filename = resolvePath(resolveDshHome(), config.filename ?? 'dsh-users.sqlite')
    let Database: (new (path: string, options?: { fileMustExist?: boolean }) => SqliteLike)
    try {
      Database = require('better-sqlite3') as typeof Database
    } catch {
      return missingDriver('sqlite', 'better-sqlite3')
    }
    const db = new Database(filename)
    db.pragma('journal_mode = WAL')
    return {
      engine: 'sqlite',
      async query(sql, params = []) {
        return db.prepare(sql).all(...params) as SqlRow[]
      },
      async execute(sql, params = []) {
        return db.prepare(sql).run(...params).changes
      },
      async close() {
        db.close()
      },
    }
  }

  if (config.engine === 'mysql') {
    let createPool: MysqlCreatePool
    try {
      createPool = require('mysql2/promise') as MysqlCreatePool
    } catch {
      return missingDriver('mysql', 'mysql2')
    }
    const pool = createPool({
      host: config.host ?? '127.0.0.1',
      port: config.port ?? defaultPort('mysql'),
      database: config.database ?? '',
      user: config.user ?? '',
      password: config.password ?? '',
      waitForConnections: true,
      connectionLimit: 5,
      ...(config.ssl === true ? { ssl: {} } : {}),
    })
    return {
      engine: 'mysql',
      async query(sql, params = []) {
        const [rows] = await pool.query(sql, params as unknown[])
        return rows as SqlRow[]
      },
      async execute(sql, params = []) {
        const [result] = await pool.query(sql, params as unknown[])
        return Number((result as { affectedRows?: number }).affectedRows ?? 0)
      },
      async close() {
        await pool.end()
      },
    }
  }

  let pg: PgModule
  try {
    pg = require('pg') as PgModule
  } catch {
    return missingDriver('postgres', 'pg')
  }
  const pool = new pg.Pool({
    host: config.host ?? '127.0.0.1',
    port: config.port ?? defaultPort('postgres'),
    database: config.database ?? '',
    user: config.user ?? '',
    password: config.password ?? '',
    ...(config.ssl === true ? { ssl: {} } : {}),
  })
  return {
    engine: 'postgres',
    async query(sql, params = []) {
      const result = await pool.query(sql, params as unknown[])
      return result.rows as SqlRow[]
    },
    async execute(sql, params = []) {
      const result = await pool.query(sql, params as unknown[])
      return result.rowCount ?? 0
    },
    async close() {
      await pool.end()
    },
  }
}

/**
 * 建表。仅 CREATE TABLE IF NOT EXISTS —— 不做迁移，字段随后续版本以
 * ALTER TABLE 增量补齐（目前只有 v1）。
 */
export async function ensureSchema(client: SqlClient): Promise<void> {
  const d = DIALECTS[client.engine]
  const q = d.quote
  const autoIncrement = client.engine === 'sqlite'
    ? 'INTEGER PRIMARY KEY AUTOINCREMENT'
    : client.engine === 'mysql'
      ? 'BIGINT AUTO_INCREMENT PRIMARY KEY'
      : 'BIGSERIAL PRIMARY KEY'
  const falseLiteral = String(d.bool(false))
  const boolType = client.engine === 'postgres' ? 'BOOLEAN' : 'TINYINT(1)'
  const table = q('users')
  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${table} (
      ${q('id')} ${autoIncrement},
      ${q('username')} VARCHAR(191) NOT NULL UNIQUE,
      ${q('display_name')} VARCHAR(191) NOT NULL,
      ${q('password_hash')} VARCHAR(255),
      ${q('role')} VARCHAR(16) NOT NULL DEFAULT 'user',
      ${q('disabled')} ${boolType} NOT NULL DEFAULT ${falseLiteral},
      ${q('source')} VARCHAR(16) NOT NULL DEFAULT 'database',
      ${q('created_at')} VARCHAR(40) NOT NULL
    )`,
  )
}

/** 供上层拼 SQL 时使用的方言工具。 */
export function dialectFor(engine: DatabaseConfig['engine']): SqlDialect {
  return DIALECTS[engine]
}

/* ── 第三方驱动的最小结构声明（避免强依赖其 d.ts） ── */

interface SqliteRunResult {
  changes: number
}
interface SqliteStatement {
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): SqliteRunResult
}
interface SqliteLike {
  pragma(source: string): unknown
  prepare(sql: string): SqliteStatement
  close(): void
}

type MysqlCreatePool = (options: Record<string, unknown>) => {
  query(sql: string, params: readonly unknown[]): Promise<[unknown, unknown]>
  end(): Promise<void>
}

interface PgModule {
  Pool: new (options: Record<string, unknown>) => {
    query(sql: string, params: readonly unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
    end(): Promise<void>
  }
}
