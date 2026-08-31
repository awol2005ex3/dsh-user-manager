/**
 * 用户管理插件 · 浏览器端 bundle 模块体。
 *
 * 构建契约（deepseek-harness packages/client/tsdown.client.ts 的闭包工厂格式）：
 * 本文件经 tsc 编译后，由 scripts/wrap-client.mjs 包上
 *   banner: window.__ModuleLoader__.load({ id, factory: (require) => {
 *   intro : var module = { exports: {} }; var exports = module.exports;
 *   footer: return module.exports; } });
 * 成为惰性 CJS bundle。副作用全部位于工厂闭包内。
 *
 * 本文件刻意不含任何 import/export 语句（除结尾的 module.exports 赋值），
 * 且不使用 TS 特有语法（enum / namespace / 参数属性 / satisfies），
 * 以便 tsc 产出的是可直接执行的经典脚本。
 *
 * 功能：
 *   1. 登录遮罩 —— 未登录时盖住应用，登录成功后刷新页面；
 *   2. 用户管理面板 —— 管理员可见，做用户增删改与数据库 / LDAP 连接配置。
 */

var PLUGIN_ID = 'dsh-user-manager'
var ENDPOINT_ME = '/user-manager/me'

/** 构建外壳（scripts/wrap-client.mjs 的 intro）注入的 CJS 语义，仅类型层面使用。 */
declare const module: { exports: unknown }

/** 浏览器全局的窄访问面。 */
var win = window as unknown as {
  __dshUserManagerMounted?: boolean
}
var doc = document

/* ── DOM 工具 ── */

interface ElProps { style?: string; [key: string]: unknown }

function el(tag: string, props?: ElProps, children?: (Node | string)[]): HTMLElement {
  var node = doc.createElement(tag)
  if (props) {
    for (var key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue
      if (key === 'style') node.setAttribute('style', props[key] as string)
      else (node as unknown as Record<string, unknown>)[key] = props[key]
    }
  }
  if (children) {
    for (var i = 0; i < children.length; i++) {
      var child: Node | string = children[i] as Node | string
      node.append(typeof child === 'string' ? doc.createTextNode(child) : child)
    }
  }
  return node
}

/** 表单控件的窄面：只用得到这些成员。 */
interface FieldElement extends HTMLElement {
  value: string
  disabled: boolean
  checked?: boolean
  cssText?: string
}

function input(placeholder: string, type: string, value: string): FieldElement {
  return el('input', {
    type: type,
    value: value,
    placeholder: placeholder,
    style: INPUT_CSS,
  }) as unknown as FieldElement
}

function button(label: string, onClick: () => void, primary?: boolean): FieldElement {
  var btn = el('button', {
    type: 'button',
    textContent: label,
    style: BTN_CSS + (primary === true ? PRIMARY_CSS : ''),
  }) as unknown as FieldElement
  btn.addEventListener('click', function (e: Event) {
    e.preventDefault()
    e.stopPropagation()
    onClick()
  })
  return btn
}

function field(labelText: string, node: HTMLElement): HTMLElement {
  return el('label', { style: 'display:block;margin-bottom:10px;font-size:12px;color:#9aa3b2;' }, [
    el('div', { textContent: labelText, style: 'margin-bottom:4px;' }),
    node,
  ])
}

function row(children: (Node | string)[], gap: string): HTMLElement {
  return el('div', { style: 'display:flex;gap:' + gap + ';align-items:center;flex-wrap:wrap;' }, children)
}

/* ── 样式 ── */

var OVERLAY_CSS = [
  'position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;',
  'justify-content:center;background:#16181d;color:#e6e6e6;',
  'font:14px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;',
].join('')

var CARD_CSS = 'width:340px;padding:28px;background:#1e2128;border:1px solid #2e323b;border-radius:12px;'

var INPUT_CSS = [
  'width:100%;box-sizing:border-box;padding:9px 11px;background:#14161b;',
  'border:1px solid #343944;border-radius:8px;color:#e6e6e6;font-size:14px;outline:none;',
].join('')

var BTN_CSS = [
  'padding:8px 14px;font-size:13px;cursor:pointer;border-radius:8px;',
  'border:1px solid #3a4252;background:#262b34;color:#e6e6e6;',
].join('')

var PRIMARY_CSS = 'background:#4d7cfe;border-color:#4d7cfe;color:#fff;'

var PANEL_CSS = [
  'position:fixed;left:16px;bottom:64px;z-index:2147483646;width:420px;max-height:74vh;',
  'overflow:auto;background:#1e2128;color:#e6e6e6;border:1px solid #2e323b;border-radius:12px;',
  'box-shadow:0 8px 28px rgba(0,0,0,.45);padding:14px;',
  'font:13px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;',
].join('')

var SIDEBAR_BTN_CSS = [
  'display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;',
  'margin:4px 0;padding:8px 10px;font-size:13px;cursor:pointer;',
  'border:1px solid rgba(127,127,127,.25);background:transparent;color:inherit;',
  'border-radius:8px;',
].join('')

var FLOAT_BTN_CSS = [
  'position:fixed;left:16px;bottom:16px;z-index:2147483647;padding:9px 14px;',
  'font-size:13px;background:#4d7cfe;color:#fff;border:none;border-radius:8px;',
  'box-shadow:0 2px 8px rgba(0,0,0,.3);margin:0;',
].join('')

/* ── 接口与请求 ── */

interface UserRecord {
  id: string
  username: string
  displayName: string
  role: string
  disabled: boolean
  source: string
  createdAt: string
}

interface MeResponse {
  ok: boolean
  user?: { userId: string; username: string; displayName: string; role: string }
  mode?: string
  enforce?: boolean
  error?: string
}

interface ConnectionResponse {
  ok: boolean
  mode: string
  database?: Record<string, unknown>
  ldap?: Record<string, unknown>
  writable?: boolean
  error?: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function post(endpoint: string, body: unknown): Promise<unknown> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) {
    return r.json().then(function (d: unknown) {
      var data = d as { ok?: boolean; error?: string }
      if (r.status !== 200 || data.ok !== true) {
        throw new Error(data.error || ('请求失败（' + r.status + '）'))
      }
      return d
    })
  })
}

function get(endpoint: string): Promise<unknown> {
  return fetch(endpoint, { headers: { accept: 'application/json' } }).then(function (r) {
    return r.json()
  })
}

/* ── 登录遮罩 ── */

function showLoginOverlay(): void {
  if (doc.getElementById('dsh-user-manager-overlay') !== null) return
  var error = el('div', { style: 'margin-top:12px;min-height:18px;font-size:12px;color:#ff7b72;' })

  var username = input('用户名', 'text', '')
  var password = input('密码', 'password', '')

  var submit = button('登录', function () {
    error.textContent = ''
    submit.disabled = true
    post('/user-manager/login', { username: username.value, password: password.value })
      .then(function () {
        // 应用已带着失效的登录态初始化过，刷新最干净。
        location.reload()
      })
      .catch(function (err: unknown) {
        error.textContent = messageOf(err)
        submit.disabled = false
      })
  }, true)

  function send(): void {
    submit.click()
  }
  password.addEventListener('keydown', function (e: KeyboardEvent) {
    if (e.key === 'Enter') send()
  })
  username.addEventListener('keydown', function (e: KeyboardEvent) {
    if (e.key === 'Enter') send()
  })

  var card = el('div', { style: CARD_CSS }, [
    el('h1', { textContent: 'DeepSeek Harness', style: 'margin:0 0 4px;font-size:17px;font-weight:600;' }),
    el('p', { textContent: '登录后进入你的会话空间', style: 'margin:0 0 20px;font-size:12px;color:#8b919c;' }),
    field('用户名', username),
    field('密码', password),
    submit,
    error,
  ])

  var overlay = el('div', { id: 'dsh-user-manager-overlay', style: OVERLAY_CSS }, [card])
  doc.body.append(overlay)
}

/* ── 用户管理面板 ── */

function buildUserPanel(): HTMLElement {
  var status = el('div', { style: 'margin:6px 0;min-height:18px;color:#8b919c;font-size:12px;' })

  function setStatus(text: string): void {
    status.textContent = text
  }
  function fail(err: unknown): void {
    setStatus('错误：' + messageOf(err))
  }

  var users: UserRecord[] = []
  var connection: ConnectionResponse | null = null

  /* 用户列表 */
  var userList = el('div', { style: 'margin:8px 0;display:flex;flex-direction:column;gap:6px;' })

  function renderUsers(): void {
    userList.replaceChildren()
    if (users.length === 0) {
      userList.append(el('div', { textContent: '暂无用户', style: 'color:#8b919c;' }))
      return
    }
    var head = row([
      el('div', { textContent: '用户名', style: 'flex:2;font-weight:600;' }),
      el('div', { textContent: '角色', style: 'flex:1;font-weight:600;' }),
      el('div', { textContent: '来源', style: 'flex:1;font-weight:600;' }),
      el('div', { textContent: '操作', style: 'width:150px;font-weight:600;' }),
    ], '4px')
    userList.append(head)

    for (var i = 0; i < users.length; i++) {
      (function (u: UserRecord) {
        var roleBtn = button(u.role === 'admin' ? '设为普通' : '设为管理', function () {
          post('/user-manager/user/update', { id: u.id, role: u.role === 'admin' ? 'user' : 'admin' })
            .then(function () { return refreshUsers() })
            .then(function () { setStatus('已更新 ' + u.username) })
            .catch(fail)
        })
        var toggleBtn = button(u.disabled ? '启用' : '停用', function () {
          post('/user-manager/user/update', { id: u.id, disabled: !u.disabled })
            .then(function () { return refreshUsers() })
            .then(function () { setStatus('已更新 ' + u.username) })
            .catch(fail)
        })
        var delBtn = button('删除', function () {
          if (!window.confirm('删除用户 ' + u.username + '？')) return
          post('/user-manager/user/delete', { id: u.id })
            .then(function () { return refreshUsers() })
            .then(function () { setStatus('已删除 ' + u.username) })
            .catch(fail)
        })
        userList.append(row([
          el('div', { textContent: u.displayName + '（' + u.username + '）' + (u.disabled ? ' [停用]' : ''), style: 'flex:2;' }),
          el('div', { textContent: u.role === 'admin' ? '管理员' : '普通', style: 'flex:1;' }),
          el('div', { textContent: u.source === 'ldap' ? 'LDAP' : '数据库', style: 'flex:1;' }),
          el('div', { style: 'width:150px;display:flex;gap:4px;' }, [roleBtn, toggleBtn, delBtn]),
        ], '4px'))
      })(users[i]!)
    }
  }

  function refreshUsers(): Promise<void> {
    return get('/user-manager/users').then(function (d: unknown) {
      var res = d as { ok?: boolean; users?: UserRecord[]; error?: string }
      if (res.ok !== true) throw new Error(res.error || '读取用户失败')
      users = res.users || []
      renderUsers()
    })
  }

  /* 新建用户 */
  var newName = input('用户名', 'text', '')
  var newDisplay = input('显示名（可选）', 'text', '')
  var newPass = input('初始密码（至少 8 位）', 'password', '')
  var newRole = el('select', { style: INPUT_CSS }, [
    el('option', { value: 'user', textContent: '普通用户' }),
    el('option', { value: 'admin', textContent: '管理员' }),
  ]) as unknown as FieldElement

  var createBtn = button('新建', function () {
    post('/user-manager/users', {
      username: newName.value.trim(),
      password: newPass.value,
      displayName: newDisplay.value.trim() || undefined,
      role: newRole.value,
    })
      .then(function () {
        newName.value = ''
        newDisplay.value = ''
        newPass.value = ''
        return refreshUsers()
      })
      .then(function () { setStatus('已创建用户') })
      .catch(fail)
  }, true)

  var createBox = el('div', { style: 'border-top:1px solid #2e323b;padding-top:10px;margin-top:6px;' }, [
    el('div', { textContent: '新建用户', style: 'font-weight:600;margin-bottom:6px;' }),
    field('用户名', newName),
    field('显示名', newDisplay),
    field('初始密码', newPass),
    field('角色', newRole),
    createBtn,
  ])

  /* 连接配置 */
  var modeSelect = el('select', { style: INPUT_CSS }, [
    el('option', { value: 'database', textContent: '数据库' }),
    el('option', { value: 'ldap', textContent: 'LDAP' }),
  ]) as unknown as FieldElement

  var dbEngine = el('select', { style: INPUT_CSS }, [
    el('option', { value: 'sqlite', textContent: 'SQLite' }),
    el('option', { value: 'mysql', textContent: 'MySQL' }),
    el('option', { value: 'postgres', textContent: 'PostgreSQL' }),
  ]) as unknown as FieldElement
  var dbFile = input('dsh-users.sqlite', 'text', '')
  var dbHost = input('127.0.0.1', 'text', '')
  var dbPort = input('端口（留空用默认）', 'text', '')
  var dbName = input('库名', 'text', '')
  var dbUser = input('账号', 'text', '')
  var dbPass = input('口令', 'password', '')
  var dbSsl = el("input", { type: "checkbox" }) as unknown as FieldElement

  var dbBox = el('div', {}, [
    field('引擎', dbEngine),
    field('SQLite 文件（相对 DSH_HOME）', dbFile),
    field('主机', dbHost),
    field('端口', dbPort),
    field('库名', dbName),
    field('账号', dbUser),
    field('口令', dbPass),
    row([dbSsl, el('span', { textContent: '使用 SSL', style: 'font-size:12px;' })], '6px'),
  ])

  var ldapUrl = input('ldap://host:389 或 ldaps://host:636', 'text', '')
  var ldapBindDn = input('CN=admin,DC=example,DC=com', 'text', '')
  var ldapBindPass = input('绑定口令', 'password', '')
  var ldapBase = input('OU=Users,DC=example,DC=com', 'text', '')
  var ldapFilter = input('(sAMAccountName={username})', 'text', '')
  var ldapDisplay = input('displayName', 'text', '')
  var ldapAdmins = el('textarea', {
    placeholder: '映射为管理员的 DN，一行一个',
    style: INPUT_CSS + 'min-height:56px;resize:vertical;',
  }) as unknown as FieldElement
  var ldapTls = el("input", { type: "checkbox" }) as unknown as FieldElement

  var ldapBox = el('div', {}, [
    field('目录地址', ldapUrl),
    field('绑定 DN（留空则匿名）', ldapBindDn),
    field('绑定口令', ldapBindPass),
    field('基准 DN', ldapBase),
    field('登录名过滤模板', ldapFilter),
    field('显示名属性', ldapDisplay),
    field('管理员 DN 列表', ldapAdmins),
    row([ldapTls, el('span', { textContent: '校验证书', style: 'font-size:12px;' })], '6px'),
  ])

  var configBox = el('div', {})

  function applyMode(): void {
    configBox.replaceChildren()
    if (modeSelect.value === 'ldap') configBox.append(ldapBox)
    else configBox.append(dbBox)
  }
  modeSelect.addEventListener('change', applyMode)
  dbEngine.addEventListener('change', applyMode)

  function fillConnection(res: ConnectionResponse): void {
    connection = res
    modeSelect.value = res.mode === 'ldap' ? 'ldap' : 'database'
    var db = res.database || {}
    dbEngine.value = String(db.engine || 'sqlite')
    dbFile.value = String(db.filename || 'dsh-users.sqlite')
    dbHost.value = String(db.host || '127.0.0.1')
    dbPort.value = db.port === undefined || db.port === null ? '' : String(db.port)
    dbName.value = String(db.database || '')
    dbUser.value = String(db.user || '')
    dbPass.value = String(db.password || '')
    dbSsl.checked = db.ssl === true

    var ldap = res.ldap || {}
    ldapUrl.value = String(ldap.url || '')
    ldapBindDn.value = String(ldap.bindDn || '')
    ldapBindPass.value = String(ldap.bindPassword || '')
    ldapBase.value = String(ldap.searchBase || '')
    ldapFilter.value = String(ldap.searchFilter || '(sAMAccountName={username})')
    ldapDisplay.value = String(ldap.displayNameAttribute || 'displayName')
    var dns = ldap.adminDns
    ldapAdmins.value = Array.isArray(dns) ? dns.join('\n') : ''
    ldapTls.checked = ldap.tlsRejectUnauthorized !== false
    applyMode()
  }

  function collectBody(): unknown {
    if (modeSelect.value === 'ldap') {
      return {
        mode: 'ldap',
        ldap: {
          url: ldapUrl.value.trim(),
          bindDn: ldapBindDn.value.trim() || undefined,
          bindPassword: ldapBindPass.value || undefined,
          searchBase: ldapBase.value.trim(),
          searchFilter: ldapFilter.value.trim() || '(sAMAccountName={username})',
          displayNameAttribute: ldapDisplay.value.trim() || undefined,
          adminDns: ldapAdmins.value.split('\n').map(function (s) { return s.trim() }).filter(function (s) { return s !== '' }),
          tlsRejectUnauthorized: ldapTls.checked,
        },
      }
    }
    var engine = dbEngine.value
    var db: Record<string, unknown> = { engine: engine }
    if (engine === 'sqlite') {
      db.filename = dbFile.value.trim() || 'dsh-users.sqlite'
    } else {
      db.host = dbHost.value.trim()
      db.database = dbName.value.trim()
      db.user = dbUser.value.trim()
      if (dbPass.value !== '') db.password = dbPass.value
      if (dbPort.value.trim() !== '') db.port = Number(dbPort.value.trim())
      db.ssl = dbSsl.checked
    }
    return { mode: 'database', database: db }
  }

  var testBtn = button('测试连接', function () {
    setStatus('测试中…')
    post('/user-manager/connection/test', collectBody())
      .then(function (d: unknown) {
        var res = d as { users?: number; entries?: number }
        setStatus(res.users === undefined
          ? ('连接成功，目录命中 ' + String(res.entries) + ' 条')
          : ('连接成功，已有 ' + res.users + ' 个用户'))
      })
      .catch(fail)
  })

  var saveBtn = button('保存并切换', function () {
    setStatus('保存中…')
    post('/user-manager/connection', collectBody())
      .then(function () {
        setStatus('已切换用户库')
        return refreshConnection()
      })
      .then(function () { return refreshUsers() })
      .catch(fail)
  }, true)

  function refreshConnection(): Promise<void> {
    return get('/user-manager/connection').then(function (d: unknown) {
      var res = d as ConnectionResponse
      if (res.ok !== true) throw new Error(res.error || '读取连接配置失败')
      fillConnection(res)
      var writable = res.writable !== false
      createBtn.disabled = !writable
      createBtn.textContent = writable ? '新建' : '目录只读'
    })
  }

  var configSection = el('div', { style: 'border-top:1px solid #2e323b;padding-top:10px;margin-top:6px;' }, [
    el('div', { textContent: '用户库配置', style: 'font-weight:600;margin-bottom:6px;' }),
    field('模式', modeSelect),
    configBox,
    row([testBtn, saveBtn], '8px'),
  ])

  /* 改自己密码 */
  var oldPass = input('当前密码', 'password', '')
  var nextPass = input('新密码（至少 8 位）', 'password', '')
  var passBtn = button('修改密码', function () {
    post('/user-manager/password', { currentPassword: oldPass.value, newPassword: nextPass.value })
      .then(function () {
        oldPass.value = ''
        nextPass.value = ''
        setStatus('密码已修改，请重新登录')
      })
      .catch(fail)
  })

  var passSection = el('div', { style: 'border-top:1px solid #2e323b;padding-top:10px;margin-top:6px;' }, [
    el('div', { textContent: '修改密码', style: 'font-weight:600;margin-bottom:6px;' }),
    field('当前密码', oldPass),
    field('新密码', nextPass),
    passBtn,
  ])

  var logoutBtn = button('退出登录', function () {
    post('/user-manager/logout', {}).then(function () { location.reload() }).catch(function () {
      location.reload()
    })
  })

  var closeBtn = el('button', {
    type: 'button',
    textContent: '✕',
    title: '关闭',
    style: 'padding:2px 8px;font-size:13px;line-height:1;cursor:pointer;border:1px solid #3a4252;' +
      'background:#262b34;color:#9aa3b2;border-radius:6px;',
  }) as unknown as FieldElement

  var root = el('div', { id: 'dsh-user-manager-panel', style: PANEL_CSS }, [
    el('div', { style: 'display:flex;justify-content:space-between;align-items:center;' }, [
      el('div', { textContent: '👥 用户管理', style: 'font-weight:600;font-size:14px;' }),
      el('div', { style: 'display:flex;gap:6px;align-items:center;' }, [logoutBtn, closeBtn]),
    ]),
    status,
    userList,
    createBox,
    passSection,
    configSection,
  ])

  closeBtn.addEventListener('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
    root.style.display = 'none'
  })

  setStatus('加载中…')
  refreshConnection().then(function () { return refreshUsers() }).then(function () {
    setStatus('')
  }).catch(fail)

  return root
}

/* ── 侧边栏挂载（缺失时回退浮动按钮） ── */

var SIDEBAR_SLOT = 'sidebar.footer.action'

function mountLauncher(launcher: FieldElement): void {
  function sidebarHost(): Element | null {
    return doc.querySelector('[data-slot="' + SIDEBAR_SLOT + '"]')
  }
  function ensureMounted(): void {
    var host = sidebarHost()
    if (host) {
      if (launcher.parentElement !== host) {
        host.append(launcher)
        launcher.style.cssText = SIDEBAR_BTN_CSS
      }
    } else if (launcher.parentElement !== doc.body) {
      doc.body.append(launcher)
      launcher.style.cssText = FLOAT_BTN_CSS
    }
  }
  ensureMounted()
  var observer = new MutationObserver(function () { ensureMounted() })
  observer.observe(doc.documentElement, { childList: true, subtree: true })
}

/* ── 插件契约 ── */

function apply(ctx: unknown): void {
  if (win.__dshUserManagerMounted === true) return
  win.__dshUserManagerMounted = true

  var context = ctx as { connection?: { rpc?: unknown } }
  // 客户端只做 UI，全部数据走 /user-manager/*，不强依赖 connection 服务。
  void context

  function boot(): void {
    fetch(ENDPOINT_ME, { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json() as Promise<MeResponse> })
      .then(function (me) {
        if (me.ok !== true) {
          showLoginOverlay()
          return
        }
        if (me.user && me.user.role === 'admin') mountAdminPanel(me.user.displayName)
      })
      .catch(function () {
        showLoginOverlay()
      })
  }

  function mountAdminPanel(displayName: string): void {
    var panel = buildUserPanel()
    panel.style.display = 'none'
    doc.body.append(panel)

    var launcher = button('👥 用户', function () {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none'
    })
    launcher.id = 'dsh-user-manager-launcher'
    launcher.title = '用户管理（' + displayName + '）'
    mountLauncher(launcher)
  }

  if (doc.body) boot()
  else doc.addEventListener('DOMContentLoaded', boot)
}

// 工厂返回值即插件模块表：loader 从中读取 name / inject / apply 组装 fiber。
module.exports = { name: PLUGIN_ID, inject: ['connection'], apply: apply }
