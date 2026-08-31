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
 *   2. 用户面板 —— 多页面结构：
 *        · 用户列表（管理员）—— 表格 + 行内操作
 *        · 新建用户（管理员）—— 独立表单页
 *        · 用户库配置（管理员）—— 数据库 / LDAP 模式与连接
 *        · 我的密码（所有人）—— 修改本人登录口令
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
  'position:fixed;left:16px;bottom:64px;z-index:2147483646;width:460px;max-height:78vh;',
  'overflow:auto;background:#1e2128;color:#e6e6e6;border:1px solid #2e323b;border-radius:12px;',
  'box-shadow:0 8px 28px rgba(0,0,0,.45);padding:14px;',
  'font:13px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;',
].join('')

var NAV_CSS = 'display:flex;gap:2px;border-bottom:1px solid #2e323b;margin:6px 0 12px;'
var NAV_ITEM_CSS = 'padding:7px 11px;font-size:12px;cursor:pointer;border:none;background:transparent;' +
  'color:#9aa3b2;border-bottom:2px solid transparent;'
var NAV_ACTIVE_CSS = 'color:#e6e6e6;border-bottom-color:#4d7cfe;'
var PAGE_TITLE_CSS = 'font-weight:600;font-size:14px;margin:0 0 10px;'

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

/** 一个页面视图：自身 DOM + 可选刷新（进入该页时调用）。 */
interface PageView {
  el: HTMLElement
  refresh?: () => Promise<void> | void
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

/* ── 页面：用户列表（管理员） ── */

function buildUserListPage(onChanged: () => void): PageView {
  var status = el('div', { style: 'margin:6px 0;min-height:18px;color:#8b919c;font-size:12px;' })
  var userList = el('div', { style: 'margin:8px 0;display:flex;flex-direction:column;gap:6px;' })
  var users: UserRecord[] = []

  function renderUsers(): void {
    userList.replaceChildren()
    if (users.length === 0) {
      userList.append(el('div', { textContent: '暂无用户', style: 'color:#8b919c;' }))
      return
    }
    userList.append(row([
      el('div', { textContent: '用户名', style: 'flex:2;font-weight:600;' }),
      el('div', { textContent: '角色', style: 'flex:1;font-weight:600;' }),
      el('div', { textContent: '来源', style: 'flex:1;font-weight:600;' }),
      el('div', { textContent: '操作', style: 'width:150px;font-weight:600;' }),
    ], '4px'))

    for (var i = 0; i < users.length; i++) {
      (function (u: UserRecord) {
        var roleBtn = button(u.role === 'admin' ? '设为普通' : '设为管理', function () {
          post('/user-manager/user/update', { id: u.id, role: u.role === 'admin' ? 'user' : 'admin' })
            .then(function () { return refresh() }).then(function () { status.textContent = '已更新 ' + u.username })
            .catch(function (err) { status.textContent = '错误：' + messageOf(err) })
        })
        var toggleBtn = button(u.disabled ? '启用' : '停用', function () {
          post('/user-manager/user/update', { id: u.id, disabled: !u.disabled })
            .then(function () { return refresh() }).then(function () { status.textContent = '已更新 ' + u.username })
            .catch(function (err) { status.textContent = '错误：' + messageOf(err) })
        })
        var delBtn = button('删除', function () {
          if (!window.confirm('删除用户 ' + u.username + '？此操作不可撤销')) return
          post('/user-manager/user/delete', { id: u.id })
            .then(function () { return refresh() }).then(function () { status.textContent = '已删除 ' + u.username })
            .catch(function (err) { status.textContent = '错误：' + messageOf(err) })
        })
        userList.append(row([
          el('div', {
            textContent: u.displayName + '（' + u.username + '）' + (u.disabled ? ' [停用]' : ''),
            style: 'flex:2;',
          }),
          el('div', { textContent: u.role === 'admin' ? '管理员' : '普通', style: 'flex:1;' }),
          el('div', { textContent: u.source === 'ldap' ? 'LDAP' : '数据库', style: 'flex:1;' }),
          el('div', { style: 'width:150px;display:flex;gap:4px;' }, [roleBtn, toggleBtn, delBtn]),
        ], '4px'))
      })(users[i]!)
    }
  }

  function refresh(): Promise<void> {
    return get('/user-manager/users').then(function (d: unknown) {
      var res = d as { ok?: boolean; users?: UserRecord[]; error?: string }
      if (res.ok !== true) throw new Error(res.error || '读取用户失败')
      users = res.users || []
      renderUsers()
      status.textContent = '共 ' + users.length + ' 个用户'
      onChanged()
    }).catch(function (err) {
      status.textContent = '错误：' + messageOf(err)
    })
  }

  var root = el('div', {}, [status, userList])
  return { el: root, refresh: refresh }
}

/* ── 页面：新建用户（管理员） ── */

function buildCreateUserPage(onCreated: () => void): PageView {
  var status = el('div', { style: 'margin:6px 0;min-height:18px;color:#8b919c;font-size:12px;' })

  var newName = input('用户名', 'text', '')
  var newDisplay = input('显示名（可选）', 'text', '')
  var newPass = input('初始密码（至少 8 位）', 'password', '')
  var newRole = el('select', { style: INPUT_CSS }, [
    el('option', { value: 'user', textContent: '普通用户' }),
    el('option', { value: 'admin', textContent: '管理员' }),
  ]) as unknown as FieldElement

  var createBtn = button('创建用户', function () {
    status.textContent = '创建中…'
    createBtn.disabled = true
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
        status.textContent = '已创建用户'
        onCreated()
      })
      .catch(function (err) { status.textContent = '错误：' + messageOf(err) })
      .finally(function () { createBtn.disabled = false })
  }, true)

  var root = el('div', {}, [
    el('div', { textContent: '填写新用户的登录名与初始口令。', style: 'font-size:12px;color:#8b919c;margin-bottom:10px;' }),
    field('用户名', newName),
    field('显示名', newDisplay),
    field('初始密码', newPass),
    field('角色', newRole),
    createBtn,
    status,
  ])
  return { el: root }
}

/* ── 页面：用户库配置（管理员） ── */

function buildConfigPage(onSaved: () => void): PageView {
  var status = el('div', { style: 'margin:6px 0;min-height:18px;color:#8b919c;font-size:12px;' })
  var connection: ConnectionResponse | null = null

  var modeSelect = el('select', { style: INPUT_CSS }, [
    el('option', { value: 'database', textContent: '数据库' }),
    el('option', { value: 'ldap', textContent: 'LDAP' }),
  ]) as unknown as FieldElement

  /* 数据库子表单 */
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
  var dbSsl = el('input', { type: 'checkbox' }) as unknown as FieldElement

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

  /* LDAP 子表单 */
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
  var ldapTls = el('input', { type: 'checkbox' }) as unknown as FieldElement

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
    status.textContent = '测试中…'
    post('/user-manager/connection/test', collectBody())
      .then(function (d: unknown) {
        var res = d as { users?: number; entries?: number }
        status.textContent = res.users === undefined
          ? ('连接成功，目录命中 ' + String(res.entries) + ' 条')
          : ('连接成功，已有 ' + res.users + ' 个用户')
      })
      .catch(function (err) { status.textContent = '错误：' + messageOf(err) })
  })

  var saveBtn = button('保存并切换', function () {
    status.textContent = '保存中…'
    post('/user-manager/connection', collectBody())
      .then(function () { status.textContent = '已切换用户库'; return refresh() })
      .then(function () { onSaved() })
      .catch(function (err) { status.textContent = '错误：' + messageOf(err) })
  }, true)

  var root = el('div', {}, [
    el('div', { textContent: '选择用户来源并填写连接信息，保存后即时切换。', style: 'font-size:12px;color:#8b919c;margin-bottom:10px;' }),
    field('模式', modeSelect),
    configBox,
    row([testBtn, saveBtn], '8px'),
    status,
  ])

  function refresh(): Promise<void> {
    return get('/user-manager/connection').then(function (d: unknown) {
      var res = d as ConnectionResponse
      if (res.ok !== true) throw new Error(res.error || '读取连接配置失败')
      fillConnection(res)
      var writable = res.writable !== false
      status.textContent = writable ? '当前可写入' : '当前为只读目录'
    }).catch(function (err) {
      status.textContent = '错误：' + messageOf(err)
    })
  }

  return { el: root, refresh: refresh }
}

/* ── 页面：我的密码（所有人） ── */

function buildPasswordPage(): PageView {
  var status = el('div', { style: 'margin:6px 0;min-height:18px;color:#8b919c;font-size:12px;' })
  var oldPass = input('当前密码', 'password', '')
  var nextPass = input('新密码（至少 8 位）', 'password', '')

  var passBtn = button('修改密码', function () {
    status.textContent = '修改中…'
    passBtn.disabled = true
    post('/user-manager/password', { currentPassword: oldPass.value, newPassword: nextPass.value })
      .then(function () {
        oldPass.value = ''
        nextPass.value = ''
        status.textContent = '密码已修改，请重新登录'
        setTimeout(function () { location.reload() }, 800)
      })
      .catch(function (err) { status.textContent = '错误：' + messageOf(err) })
      .finally(function () { passBtn.disabled = false })
  }, true)

  var root = el('div', {}, [
    el('div', { textContent: '修改你本人的登录口令。', style: 'font-size:12px;color:#8b919c;margin-bottom:10px;' }),
    field('当前密码', oldPass),
    field('新密码', nextPass),
    passBtn,
    status,
  ])
  return { el: root }
}

/* ── 面板装配 ── */

interface NavItem {
  id: string
  label: string
  adminOnly: boolean
}

function buildPanel(me: { userId: string; username: string; displayName: string; role: string }): HTMLElement {
  var isAdmin = me.role === 'admin'
  var defaultPage = isAdmin ? 'users' : 'password'

  // 先建列表页，供新建页回调刷新。
  var listPage = buildUserListPage(function () { /* 列表自身即数据源，无需额外动作 */ })
  var createPage = buildCreateUserPage(function () { if (listPage.refresh) listPage.refresh() })
  var configPage = buildConfigPage(function () { if (listPage.refresh) listPage.refresh() })
  var passwordPage = buildPasswordPage()

  var views: Record<string, PageView> = {
    users: listPage,
    create: createPage,
    config: configPage,
    password: passwordPage,
  }

  var navItems: NavItem[] = [
    { id: 'users', label: '用户列表', adminOnly: true },
    { id: 'create', label: '新建用户', adminOnly: true },
    { id: 'config', label: '用户库配置', adminOnly: true },
    { id: 'password', label: '我的密码', adminOnly: false },
  ].filter(function (n) { return isAdmin || !n.adminOnly })

  var content = el('div', {})

  var navButtons: Record<string, FieldElement> = {}
  function navigate(id: string): void {
    var view = views[id]
    if (view === undefined) return
    content.replaceChildren(view.el)
    for (var key in navButtons) {
      if (!Object.prototype.hasOwnProperty.call(navButtons, key)) continue
      var active = key === id
      navButtons[key]!.style.cssText = NAV_ITEM_CSS + (active ? NAV_ACTIVE_CSS : '')
    }
    if (view.refresh !== undefined) view.refresh()
  }

  var nav = el('div', { style: NAV_CSS })
  for (var i = 0; i < navItems.length; i++) {
    (function (item: NavItem) {
      var btn = el('button', {
        type: 'button',
        textContent: item.label,
        style: NAV_ITEM_CSS,
      }) as unknown as FieldElement
      btn.addEventListener('click', function (e) {
        e.preventDefault()
        e.stopPropagation()
        navigate(item.id)
      })
      navButtons[item.id] = btn
      nav.append(btn)
    })(navItems[i]!)
  }

  var logoutBtn = button('退出登录', function () {
    post('/user-manager/logout', {}).then(function () { location.reload() }).catch(function () { location.reload() })
  })

  var closeBtn = el('button', {
    type: 'button',
    textContent: '✕',
    title: '关闭',
    style: 'padding:2px 8px;font-size:13px;line-height:1;cursor:pointer;border:1px solid #3a4252;' +
      'background:#262b34;color:#9aa3b2;border-radius:6px;',
  }) as unknown as FieldElement

  var roleText = isAdmin ? '管理员' : '普通用户'
  var titleText = isAdmin ? '👥 用户管理' : '🔑 我的账户'
  var header = el('div', { style: 'display:flex;justify-content:space-between;align-items:flex-start;' }, [
    el('div', {}, [
      el('div', { textContent: titleText, style: 'font-weight:600;font-size:14px;' }),
      el('div', {
        textContent: '当前登录：' + me.displayName + '（@' + me.username + '）· ' + roleText,
        style: 'font-size:11px;color:#8b919c;margin-top:3px;',
      }),
    ]),
    el('div', { style: 'display:flex;gap:6px;align-items:center;' }, [closeBtn, logoutBtn]),
  ])

  var root = el('div', { id: 'dsh-user-manager-panel', style: PANEL_CSS }, [
    header,
    nav,
    content,
  ])

  closeBtn.addEventListener('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
    root.style.display = 'none'
  })

  // 导航栏仅多页时展示。
  if (navItems.length <= 1) nav.style.display = 'none'

  navigate(defaultPage)
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
        if (me.ok !== true || !me.user) {
          showLoginOverlay()
          return
        }
        // 所有登录用户都挂载面板：管理员四个页，普通用户仅「我的密码」。
        mountPanel(me.user)
      })
      .catch(function () {
        showLoginOverlay()
      })
  }

  function mountPanel(user: { userId: string; username: string; displayName: string; role: string }): void {
    var panel = buildPanel(user)
    panel.style.display = 'none'
    doc.body.append(panel)

    var isAdmin = user.role === 'admin'
    var launcher = button(isAdmin ? '👥 用户' : '🔑 账户', function () {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none'
    })
    launcher.id = 'dsh-user-manager-launcher'
    launcher.title = isAdmin ? ('用户管理（' + user.displayName + '）') : '我的账户'
    mountLauncher(launcher)
  }

  if (doc.body) boot()
  else doc.addEventListener('DOMContentLoaded', boot)
}

// 工厂返回值即插件模块表：loader 从中读取 name / inject / apply 组装 fiber。
module.exports = { name: PLUGIN_ID, inject: ['connection'], apply: apply }
