// 端到端装配测试：用最小假上下文驱动真实插件，验证
// 登录 → /api/session.list 过滤 → /api/session.history 越权拒绝。
// 不属于发布产物：node scripts/integration.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

let failures = 0
function check(label, condition) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}`)
  }
}

/* ── 最小 cordis 上下文 ── */
function makeContext() {
  const effects = []
  const ctx = {
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    get: name => ctx.services[name],
    services: {},
    effect: fn => { effects.push(fn) },
    runDispose: async () => {
      for (const fn of effects.reverse()) {
        const d = fn()
        if (typeof d === 'function') await d()
        else if (d && typeof d.then === 'function') await d
      }
    },
  }
  return ctx
}

/* ── 假请求 / 响应 ── */

class MockRequest extends Readable {
  constructor(method, url, headers, body) {
    super({ read() { this.push(this.pending.length === 0 ? null : this.pending.shift()) } })
    this.method = method
    this.url = url
    this.headers = headers
    this.pending = body === '' ? [] : [Buffer.from(body)]
  }
}

class MockResponse {
  constructor() {
    this.status = 200
    this.headers = {}
    this.chunks = []
  }
  writeHead(code, headers) {
    this.status = code
    Object.assign(this.headers, headers ?? {})
    return this
  }
  setHeader(name, value) { this.headers[name] = value }
  write(text) { this.chunks.push(String(text)); return true }
  end(text) { if (text !== undefined) this.chunks.push(String(text)) }
  // 真实 ServerResponse 是 EventEmitter；网关会在 res 上挂 close 监听以传递取消信号。
  on() { return this }
  off() { return this }
  get body() { return this.chunks.join('') }
}

/* ── 最小 HTTP 面 ── */
function makeWebServer() {
  const routes = new Map()
  return {
    register(route) {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
    tapIndex(transform) {
      this.taps.push(transform)
      return () => { this.taps = this.taps.filter(t => t !== transform) }
    },
    taps: [],
    async request({ method, path, headers = {}, body = '' }) {
      const route = routes.get(path)
      if (route === undefined) return { status: 404, headers: {}, body: 'not found' }
      // 用 EventEmitter 做基类：Readable 内部依赖 on/off，直接覆盖会破坏流。
      const req = new MockRequest(method, path, headers, body)
      const res = new MockResponse()
      await route.handler(req, res)
      return { status: res.status, headers: res.headers, body: res.body }
    },
    has(path) { return routes.has(path) },
  }
}

/* ── 假 apiProxy：只实现被影子化的方法 ── */
function makeApiProxy() {
  const sessions = {
    s_alice: { sessionId: 's_alice', updatedAt: 2, running: false, blank: false },
    s_bob: { sessionId: 's_bob', updatedAt: 1, running: false, blank: false },
  }
  return {
    sessions: {
      async list(request) {
        return {
          rpcId: request.rpcId,
          result: { ok: true, value: { items: Object.values(sessions) } },
        }
      },
      async create(request) {
        const id = (request.payload && request.payload.sessionId) || 's_new'
        return { rpcId: request.rpcId, result: { ok: true, value: { sessionId: id } } }
      },
      async history(request) {
        return { rpcId: request.rpcId, result: { ok: true, value: { events: [], hasMore: false } } }
      },
    },
    // 假事件流：s_new 会被 wuyijun 认领，s_alice 保持无主，s_admin 由管理员认领。
    events: {
      async *mux(request, signal) {
        yield { type: 'server-request', rpcId: 'f1', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's_new', lastSeq: 0 } }
        yield { type: 'server-request', rpcId: 'f2', method: 'session/projection', payload: { type: 'session/projection', sessionId: 's_alice', key: 'title', value: 'Alice', seq: 1 } }
        yield { type: 'server-request', rpcId: 'fa', method: 'session/subscribed', payload: { type: 'session/subscribed', sessionId: 's_admin', lastSeq: 0 } }
        yield { type: 'server-request', rpcId: 'f3', method: 'session/event', payload: { type: 'session/event', sessionId: 's_new', event: {}, view: undefined } }
        yield { type: 'server-request', rpcId: 'f4', method: 'stream/error', payload: { type: 'stream/error', error: { code: 'internal', message: 'x', details: {} } } }
      },
      async *host(request, signal) {
        yield { type: 'server-request', rpcId: 'h1', method: 'host/session-added', payload: { type: 'host/session-added', sessionId: 's_new', blank: true } }
        yield { type: 'server-request', rpcId: 'h2', method: 'host/session-added', payload: { type: 'host/session-added', sessionId: 's_alice', blank: true } }
        yield { type: 'server-request', rpcId: 'ha', method: 'host/session-added', payload: { type: 'host/session-added', sessionId: 's_admin', blank: true } }
      },
    },
  }
}

/** 从 SSE 响应体里解析出 data 帧（跳过注释行）。 */
function parseSse(body) {
  const frames = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue
    frames.push(JSON.parse(line.slice(6)))
  }
  return frames
}

const home = mkdtempSync(join(tmpdir(), 'dsh-um-it-'))
process.env.DSH_HOME = home
process.env.DSH_ADMIN_USERNAME = 'root'
process.env.DSH_ADMIN_PASSWORD = 'rootpass123'
process.env.DSH_SESSION_SECRET = 'it-secret'

try {
  const { apply, name, inject } = await import('../lib/index.js')

  check('插件名', name === 'dsh-user-manager')
  check('inject 含 webServer', inject.includes('webServer'))

  const ctx = makeContext()
  const webServer = makeWebServer()
  ctx.services.webServer = webServer
  ctx.services.apiProxy = makeApiProxy()

  const config = {
    mode: 'database',
    database: { engine: 'sqlite', filename: 'users.sqlite' },
    enforce: true,
  }
  apply(ctx, config)
  // 目录是异步连接的，等一轮微任务。
  await new Promise(r => setTimeout(r, 50))

  console.log('路由注册')
  check('登录端点', webServer.has('/user-manager/login'))
  check('me 端点', webServer.has('/user-manager/me'))
  check('用户端点', webServer.has('/user-manager/users'))
  check('影子化 session.list', webServer.has('/api/session.list'))
  check('影子化 session.history', webServer.has('/api/session.history'))
  check('影子化 session.create', webServer.has('/api/session.create'))
  check('接管事件流 events.mux', webServer.has('/api/events.mux'))
  check('接管事件流 events.host', webServer.has('/api/events.host'))

  console.log('index 注入')
  const html = webServer.taps.reduce((acc, tap) => tap(acc), '<html><body><script src="/app.js"></script></body></html>')
  check('注入了遮罩脚本', html.includes('dsh-user-manager-gate'))
  check('注入位置在 body 之后', html.indexOf('dsh-user-manager-gate') > html.indexOf('<body>'))

  console.log('未登录访问')
  const anon = await webServer.request({
    method: 'POST',
    path: '/api/session.list',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} }),
  })
  const anonBody = JSON.parse(anon.body)
  check('未登录被拒', anon.status === 200 && anonBody.result.ok === false)
  check('拒绝信息可读', anonBody.result.error.message.includes('登录'))

  console.log('登录')
  const login = await webServer.request({
    method: 'POST',
    path: '/user-manager/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'rootpass123' }),
  })
  check('登录成功', login.status === 200 && JSON.parse(login.body).ok === true)
  const cookie = (login.headers['Set-Cookie'] ?? '').split(';')[0]
  check('下发 cookie', cookie.startsWith('dsh_user='))
  check('cookie HttpOnly', (login.headers['Set-Cookie'] ?? '').includes('HttpOnly'))

  const badLogin = await webServer.request({
    method: 'POST',
    path: '/user-manager/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'wrong' }),
  })
  check('错误口令被拒', badLogin.status === 401)

  console.log('登录后访问')
  const envelope = (method, payload) => JSON.stringify({
    type: 'client-request', rpcId: 'r2', method, payload,
  })
  const listed = await webServer.request({
    method: 'POST',
    path: '/api/session.list',
    headers: { 'content-type': 'application/json', cookie },
    body: envelope('session.list', {}),
  })
  const listedBody = JSON.parse(listed.body)
  check('session.list 成功', listedBody.result.ok === true)
  check('rpcId 回显', listedBody.rpcId === 'r2')
  // 两条会话都无主，管理员按 unownedSessions=admin 可见。
  check('管理员看到无主会话', listedBody.result.value.items.length === 2)

  const created = await webServer.request({
    method: 'POST',
    path: '/api/session.create',
    headers: { 'content-type': 'application/json', cookie },
    body: envelope('session.create', {}),
  })
  check('session.create 透传', JSON.parse(created.body).result.value.sessionId === 's_new')

  console.log('用户管理')
  const createUser = await webServer.request({
    method: 'POST',
    path: '/user-manager/users',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ username: 'bob', password: 'bobpass123', role: 'user' }),
  })
  check('管理员建用户', createUser.status === 200 && JSON.parse(createUser.body).ok === true)

  const users = await webServer.request({
    method: 'GET',
    path: '/user-manager/users',
    headers: { cookie },
  })
  check('列出用户含 bob', JSON.parse(users.body).users.some(u => u.username === 'bob'))

  // 以普通用户 bob 登录
  const bobLogin = await webServer.request({
    method: 'POST',
    path: '/user-manager/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'bob', password: 'bobpass123' }),
  })
  const bobCookie = (bobLogin.headers['Set-Cookie'] ?? '').split(';')[0]
  check('bob 登录成功', bobLogin.status === 200 && bobCookie.startsWith('dsh_user='))

  console.log('普通用户隔离')
  const bobList = await webServer.request({
    method: 'POST',
    path: '/api/session.list',
    headers: { 'content-type': 'application/json', cookie: bobCookie },
    body: envelope('session.list', {}),
  })
  // s_new 已被 root 认领；其余无主会话按 admin 策略对普通用户不可见。
  check('普通用户看不到他人会话', JSON.parse(bobList.body).result.value.items.length === 0)

  const bobHistory = await webServer.request({
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json', cookie: bobCookie },
    body: envelope('session.history', { sessionId: 's_new' }),
  })
  check('越权读历史被拒', JSON.parse(bobHistory.body).result.ok === false)

  const bobAdmin = await webServer.request({
    method: 'POST',
    path: '/user-manager/users',
    headers: { 'content-type': 'application/json', cookie: bobCookie },
    body: JSON.stringify({ username: 'x', password: 'xxxx1234' }),
  })
  check('普通用户建用户被拒', bobAdmin.status === 403)

  const bobSettings = await webServer.request({
    method: 'POST',
    path: '/api/settings.update',
    headers: { 'content-type': 'application/json', cookie: bobCookie },
    body: envelope('settings.update', {}),
  })
  check('普通用户改全局设置被拒', JSON.parse(bobSettings.body).result.ok === false)

  console.log('事件流隔离')
  // 建一个普通用户 wuyijun，并让他建一个会话（插件会认领 s_new → wuyijun）。
  const mkWu = await webServer.request({
    method: 'POST', path: '/user-manager/users',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ username: 'wuyijun', password: 'wupass123', role: 'user' }),
  })
  check('建 wuyijun', mkWu.status === 200 && JSON.parse(mkWu.body).ok === true)
  const wuLogin = await webServer.request({
    method: 'POST', path: '/user-manager/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wuyijun', password: 'wupass123' }),
  })
  const wuCookie = (wuLogin.headers['Set-Cookie'] ?? '').split(';')[0]
  check('wuyijun 登录', wuLogin.status === 200 && wuCookie.startsWith('dsh_user='))
  const wuCreate = await webServer.request({
    method: 'POST', path: '/api/session.create',
    headers: { 'content-type': 'application/json', cookie: wuCookie },
    body: envelope('session.create', {}),
  })
  check('wuyijun 建会话被认领', JSON.parse(wuCreate.body).result.value.sessionId === 's_new')

  // 让管理员（root）认领一个自有会话 s_admin，用于验证实时流对 owner 的透传。
  const adminOwn = await webServer.request({
    method: 'POST', path: '/api/session.create',
    headers: { 'content-type': 'application/json', cookie },
    body: envelope('session.create', { sessionId: 's_admin' }),
  })
  check('管理员认领自有会话', JSON.parse(adminOwn.body).result.value.sessionId === 's_admin')

  // admin 收 mux 流：实时流按 owner 隔离 —— 应看到自己认领的 s_admin，
  // 看不到 wuyijun 的 s_new，也看不到无主的 s_alice（无主不进任何人的实时流）。
  const mux = await webServer.request({
    method: 'GET', path: '/api/events.mux',
    headers: { cookie }, body: '',
  })
  const muxFrames = parseSse(mux.body)
  const muxSids = muxFrames.map(f => f.payload && f.payload.sessionId).filter(Boolean)
  check('mux 流是 SSE', (mux.headers['content-type'] || '').includes('text/event-stream'))
  check('mux 漏掉 wuyijun 的会话', !muxSids.includes('s_new'))
  check('mux 漏掉无主会话', !muxSids.includes('s_alice'))
  check('mux 透传管理员自有会话', muxSids.includes('s_admin'))
  check('mux 透传 stream/error', muxFrames.some(f => f.payload && f.payload.type === 'stream/error'))

  // admin 收 host 流：host/session-added(s_new) 与无主的 s_alice 都应被丢弃，
  // 仅保留管理员自有会话 s_admin。
  const host = await webServer.request({
    method: 'GET', path: '/api/events.host',
    headers: { cookie }, body: '',
  })
  const hostFrames = parseSse(host.body)
  const hostSids = hostFrames.map(f => f.payload && f.payload.sessionId).filter(Boolean)
  check('host 漏掉 wuyijun 的会话', !hostSids.includes('s_new'))
  check('host 漏掉无主会话', !hostSids.includes('s_alice'))
  check('host 透传管理员自有会话', hostSids.includes('s_admin'))

  console.log('登出')
  const logout = await webServer.request({
    method: 'POST',
    path: '/user-manager/logout',
    headers: { 'content-type': 'application/json', cookie: bobCookie },
    body: '{}',
  })
  check('登出成功', logout.status === 200)
  const afterLogout = await webServer.request({
    method: 'POST',
    path: '/api/session.list',
    headers: { 'content-type': 'application/json', cookie: bobCookie },
    body: envelope('session.list', {}),
  })
  check('登出后票据失效', JSON.parse(afterLogout.body).result.ok === false)

  await ctx.runDispose()
  check('卸载未抛错', true)
} catch (err) {
  failures++
  console.log(`  FAIL 未捕获异常：${err && err.stack ? err.stack : String(err)}`)
} finally {
  // 清理失败说明有连接没释放（Windows 上 SQLite 会锁文件），单独报告，
  // 不用它掩盖测试本身的错误。
  try {
    rmSync(home, { recursive: true, force: true })
  } catch (err) {
    failures++
    console.log(`  FAIL 临时目录清理失败（${err.code ?? '未知'}）—— 有连接未释放`)
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
