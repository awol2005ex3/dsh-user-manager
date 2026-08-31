/**
 * dsh-user-manager · 宿主半插件入口。
 *
 * 组成三块：
 *   1. `/user-manager/*` 自控路由（登录 / 登出 / 用户管理 / 连接配置）；
 *   2. `/api/<method>` 影子路由（登录态校验 + 会话归属过滤）；
 *   3. index.html 注入登录遮罩脚本。
 *
 * 为什么必须影子化 HTTP 路由：`ctx.connection.rpc.handle` 的回调签名是
 * `(endpoint, payload, signal)`，拿不到 Cookie，无法识别调用者身份。而
 * `ctx.webServer` 的匹配规则是「exact 优先，其次最长前缀」，connection 插件
 * 把 `/api` 注册为 prefix，因此这里用 exact 注册具体方法即可接管。
 */

import type { Context } from '@deepseek-ai/cordis'
import { RevocationList } from './auth.js'
import {
  BUILTIN_ADMIN_ONLY_METHODS,
  Config,
  ENV_ADMIN_PASSWORD,
  ENV_ADMIN_PASSWORD_HASH,
  ENV_ADMIN_USERNAME,
  ENV_SESSION_SECRET,
  readAdminCredential,
  readSessionSecret,
  resolveAuth,
  resolveDshHome,
  validateConfig,
} from './config.js'
import { registerApiGate, type ApiProxyLike, type RouteRegistrar } from './gate.js'
import { hijackEventUpgrades, wrapEventStreams, type EventsStreams } from './events-ws.js'
import { registerUserRoutes } from './http.js'
import { DatabaseUserDirectory } from './db/user-directory.js'
import { LdapUserDirectory } from './ldap.js'
import { renderLoginPage } from './login-page.js'
import { StateStore } from './store.js'
import type { DatabaseConfig, DirectoryMode, LdapConfig, PluginConfig, UserDirectory } from './types.js'

/** 插件 id —— 在组合后的插件树中必须唯一。 */
export const name = 'dsh-user-manager'

/**
 * 声明依赖的宿主服务。webServer 是硬依赖（整套机制都建立在它的路由表上）；
 * apiProxy 用 `ctx.get` 取，避免它未就绪时把本插件挡在加载之外。
 */
export const inject = ['webServer']

export { Config }
export type { PluginConfig }

/** 当前生效的目录实现。 */
interface AuthRuntime {
  directory: UserDirectory
  mode: DirectoryMode
  database?: DatabaseConfig
  ldap?: LdapConfig
}

/** 吊销表清扫间隔。 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000

/**
 * 插件入口（具名导出，禁止 export default —— 会丢失 inject 元数据）。
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const log = (message: string): void => { ctx.logger.warn(`dsh-user-manager: ${message}`) }

  // 合并内置的管理员专属方法与配置追加项。
  const auth = resolveAuth({
    ...config.auth,
    adminOnlyMethods: [...BUILTIN_ADMIN_ONLY_METHODS, ...(config.auth?.adminOnlyMethods ?? [])],
  })
  validateConfig(config)

  const webServer = ctx.get('webServer') as {
    register: (route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: unknown, res: unknown) => void | Promise<void>
    }) => () => void
    registerUpgrade: (route: {
      path: string
      handler: (req: unknown, socket: unknown, head: unknown) => void | Promise<void>
    }) => () => void
    tapIndex: (transform: (html: string) => string) => () => void
  } | undefined
  if (webServer === undefined) {
    log('未找到 webServer 服务，插件未启用')
    return
  }

  const store = new StateStore(`${resolveDshHome()}/user-manager.yaml`)
  store.load()

  const secret = readSessionSecret()
  const revocations = new RevocationList()
  const admin = readAdminCredential()
  if (admin === undefined) {
    log(`未设置 ${ENV_ADMIN_USERNAME} 与 ${ENV_ADMIN_PASSWORD}/${ENV_ADMIN_PASSWORD_HASH}，将没有本地管理员兜底账号`)
  }
  if (process.env[ENV_SESSION_SECRET] === undefined) {
    log(`未设置 ${ENV_SESSION_SECRET}，已使用随机密钥：重启后需要重新登录`)
  }

  /* ── 用户目录（可在页面切换） ── */

  let runtime: AuthRuntime | undefined

  const connectDirectory = async (
    mode: DirectoryMode,
    database?: DatabaseConfig,
    ldap?: LdapConfig,
  ): Promise<AuthRuntime> => {
    if (mode === 'ldap') {
      const resolved = ldap ?? config.ldap
      if (resolved === undefined) throw new Error('缺少 LDAP 配置')
      return { directory: new LdapUserDirectory(resolved), mode: 'ldap', ldap: resolved }
    }
    const resolved = database ?? config.database
    if (resolved === undefined) throw new Error('缺少数据库配置')
    const directory = await DatabaseUserDirectory.connect(resolved, auth.scryptCost)
    return { directory, mode: 'database', database: resolved }
  }

  const savedMode = store.getMode()
  const initialMode: DirectoryMode = savedMode ?? config.mode
  const initialDatabase = savedMode === undefined ? config.database : store.getDatabase()
  const initialLdap = savedMode === undefined ? config.ldap : store.getLdap()

  void connectDirectory(initialMode, initialDatabase, initialLdap).then(next => {
    runtime = next
  }).catch(err => {
    // 目录连不上不拖垮插件：环境变量管理员仍可登录并修复配置。
    log(`用户目录初始化失败，仅保留环境变量管理员：${String(err)}`)
  })

  let directory: UserDirectory = {
    authenticate: async () => null,
    list: async () => [],
    close: async () => undefined,
  }
  const getDirectory = (): UserDirectory => runtime?.directory ?? directory

  const switchDirectory = async (
    mode: DirectoryMode,
    database?: DatabaseConfig,
    ldap?: LdapConfig,
  ): Promise<void> => {
    const next = await connectDirectory(mode, database, ldap)
    const previous = runtime
    runtime = next
    directory = next.directory
    // 旧连接必须关掉：SQLite 会一直锁着文件，Windows 上尤其明显。
    if (previous !== undefined) {
      try {
        await previous.directory.close()
      } catch (err) {
        log(`关闭原用户目录失败：${String(err)}`)
      }
    }
    store.setConnection({
      mode,
      ...(next.database === undefined ? {} : { database: next.database }),
      ...(next.ldap === undefined ? {} : { ldap: next.ldap }),
    })
  }

  const getConnection = (): { mode: DirectoryMode; database?: DatabaseConfig; ldap?: LdapConfig } => ({
    mode: runtime?.mode ?? initialMode,
    ...(runtime?.database === undefined ? { database: initialDatabase } : { database: runtime.database }),
    ...(runtime?.ldap === undefined ? {} : { ldap: runtime.ldap }),
  })

  /* ── 路由注册 ── */

  // 宿主路由表接受 IncomingMessage / ServerResponse；两侧形状一致，
  // 这里统一按 unknown 签名桥接，避免把宿主类型拖进本插件。
  const register: RouteRegistrar = route => webServer.register(route)

  const disposeUserRoutes = registerUserRoutes({
    config,
    auth,
    secret,
    getDirectory,
    getConnection,
    switchDirectory,
    getAdmin: () => admin,
    track: (jti, userId, expiresAt) => revocations.track(jti, userId, expiresAt),
    isRevoked: jti => revocations.has(jti),
    revokeUser: userId => {
      revocations.addUser(userId, Date.now() + auth.sessionTtlSeconds * 1000)
    },
    log,
  }, register)

  ctx.effect(() => disposeUserRoutes, 'user-manager: routes')

  // 独立登录页（整页登录场景）。
  try {
    const disposeLoginPage = register({
      kind: 'exact',
      path: '/user-manager/login.html',
      handler: (_req, res) => {
        const response = res as { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(renderLoginPage())
      },
    })
    ctx.effect(() => disposeLoginPage, 'user-manager: login page')
  } catch (err) {
    log(`注册登录页失败：${String(err)}`)
  }

  if (config.enforce) {
    // apiProxy 是宿主网关服务：直接调它的具名方法拿真实数据，不经 HTTP，
    // 因此不会自环回本插件的影子路由，也不需要依赖宿主的私有包。
    //
    // 时序坑（真实 host 实测踩过）：本插件只 inject webServer，apply 时
    // apiProxy 可能尚未构造，ctx.get 返回 undefined —— 曾因此把整个 gate
    // 静默跳过（归属索引从不落盘，所有会话都成「无主」，隔离形同虚设）。
    // 因此未就绪时必须用 inject(['apiProxy']) 延迟装配，两种时序都覆盖。
    const filterCtx = { store, auth, log }
    const authView = { auth, secret, isRevoked: (jti: string) => revocations.has(jti) }

    const setupGate = (apiProxy: ApiProxyLike): void => {
      
      const gate = registerApiGate({
        config,
        auth,
        store,
        api: apiProxy,
        isRevoked: jti => revocations.has(jti),
        secret,
        log,
      }, register)
      ctx.effect(() => gate.dispose, 'user-manager: api gate')
      log(`已接管 ${gate.methods.length} 个 /api 方法`)

      // 浏览器的实时事件流是 WebSocket 升级（/api/events.mux、/api/events.host），
      // 走 webserver 独立的升级分发，HTTP exact 接管拦不住。包装上游流，
      // 按 AsyncLocalStorage 里的连接身份逐帧过滤（见 events-ws.ts）。
      if (apiProxy.events !== undefined) {
        ctx.effect(() => wrapEventStreams(filterCtx, apiProxy.events as EventsStreams), 'user-manager: event streams')
      }
    }

    const existing = ctx.get('apiProxy') as ApiProxyLike | undefined
    
    if (existing !== undefined) {
      setupGate(existing)
    } else {
      ctx.inject(['apiProxy'], apiCtx => {
        const api = (apiCtx as unknown as { apiProxy?: ApiProxyLike }).apiProxy
        if (api === undefined) {
          log('apiProxy 注入回调中仍不可用，会话隔离未启用（用户管理仍可用）')
          return
        }
        setupGate(api)
      })
    }

    // 升级分发鉴权不依赖 apiProxy（Cookie → 主体 → 过滤上下文），apply 时立即安装。
    const disposeHijack = hijackEventUpgrades(
      { ...filterCtx, authView },
      webServer as unknown as { server?: import('node:http').Server },
    )
    ctx.effect(() => disposeHijack, 'user-manager: websocket upgrades')
  }

  // 登录遮罩：注入在 <body> 起始处，应用脚本之前。
  const disposeTap = webServer.tapIndex(html => injectGate(html))
  ctx.effect(() => disposeTap, 'user-manager: index tap')

  // 定期清理过期的吊销登记。
  const timer = setInterval(() => { revocations.sweep() }, SWEEP_INTERVAL_MS)
  timer.unref?.()
  ctx.effect(() => () => { clearInterval(timer) }, 'user-manager: sweep')

  ctx.effect(() => async () => {
    try {
      await (runtime?.directory ?? directory).close()
    } catch {
      // 卸载时关闭失败无需阻断。
    }
  }, 'user-manager: directory')
}

/**
 * 把登录遮罩脚本插到 <body> 之后。webserver 的注入顺序是：结构化行先渲染
 * （body 行紧跟 <body> 开标签），再依次应用 tapIndex 的变换，因此这里插入的
 * 脚本排在所有注入行之后、应用自带脚本之前 —— 刚好能挡住未登录的首屏。
 */
function injectGate(html: string): string {
  const script = '<script>(function(){try{' + GATE_SCRIPT + '}catch(e){}})();</script>'
  const open = /<body(?:\s[^>]*)?>/i.exec(html)
  if (open === null) return `${script}${html}`
  const at = open.index + open[0].length
  return `${html.slice(0, at)}${script}${html.slice(at)}`
}

/**
 * 遮罩在 DOM 就绪前先插一个占位层挡住首屏，等 /user-manager/me 返回后再决定
 * 是否显示登录框。这样未登录时应用不会闪一下再被盖住。
 */
const GATE_SCRIPT = `
var id='dsh-user-manager-gate';
function hide(){var n=document.getElementById(id);if(n&&n.parentNode)n.parentNode.removeChild(n);}
function show(){
  if(document.getElementById(id))return;
  var d=document.createElement('div');
  d.id=id;
  d.setAttribute('style','position:fixed;inset:0;z-index:2147483644;background:#16181d;');
  (document.body||document.documentElement).appendChild(d);
}
show();
fetch('/user-manager/me',{headers:{accept:'application/json'}})
  .then(function(r){return r.json();})
  .then(function(d){if(d&&d.ok===true){hide();}else{window.__dshUserManagerNeedLogin=true;}})
  .catch(function(){window.__dshUserManagerNeedLogin=true;});
`
