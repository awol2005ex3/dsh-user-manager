// 运行时烟测：口令哈希、登录态票据、归属索引、SQLite 用户库。
// 不属于发布产物，CI / 本地验证用：node scripts/smoke.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPassword, verifyPassword, issueToken, verifyToken, RevocationList, readCookie, serializeCookie } from '../lib/auth.js'
import { StateStore } from '../lib/store.js'
import { DatabaseUserDirectory } from '../lib/db/user-directory.js'
import { resolveAuth, DEFAULT_AUTH } from '../lib/config.js'

let failures = 0
function check(label, condition) {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}`)
  }
}

const home = mkdtempSync(join(tmpdir(), 'dsh-um-'))
try {
  console.log('口令哈希')
  const hash = await hashPassword('correct horse battery', 16384)
  check('scrypt 格式', hash.startsWith('scrypt$16384$8$1$'))
  check('正确口令通过', await verifyPassword('correct horse battery', hash))
  check('错误口令拒绝', !(await verifyPassword('wrong', hash)))
  check('非法哈希拒绝', !(await verifyPassword('x', 'not-a-hash')))

  console.log('登录态票据')
  const auth = resolveAuth(undefined)
  const secret = 'test-secret'
  const revocations = new RevocationList()
  const { token, principal, jti } = issueToken(
    { userId: 'u1', username: 'alice', displayName: 'Alice', role: 'admin', source: 'database' },
    auth,
    secret,
  )
  check('票据三段结构', token.split('.').length === 2)
  check('验签通过', verifyToken(token, { auth, secret, revoked: j => revocations.has(j) })?.userId === 'u1')
  check('错密钥拒绝', verifyToken(token, { auth, secret: 'other', revoked: () => false }) === undefined)
  check('篡改拒绝', verifyToken(`${token}x`, { auth, secret, revoked: () => false }) === undefined)

  revocations.track(jti, 'u1', principal.expiresAt)
  check('吊销前有效', verifyToken(token, { auth, secret, revoked: j => revocations.has(j) }) !== undefined)
  revocations.addUser('u1', Date.now() + 60000)
  check('按用户吊销后失效', verifyToken(token, { auth, secret, revoked: j => revocations.has(j) }) === undefined)

  const cookie = serializeCookie(auth.cookieName, token, { maxAge: 60, sameSite: 'lax' })
  check('cookie 往返', readCookie(`a=1; ${cookie}; b=2`, auth.cookieName) === token)

  console.log('会话归属索引')
  const statePath = join(home, 'user-manager.yaml')
  const store = new StateStore(statePath)
  store.load()
  store.claim('s1', 'u1')
  store.claim('s2', 'u1')
  store.claim('s3', 'u2')
  store.save()
  const reloaded = new StateStore(statePath)
  reloaded.load()
  check('落盘后归属保留', reloaded.ownerOfSession('s1') === 'u1')
  check('owner 判定', reloaded.verdict('s1', 'u1') === 'owner')
  check('other 判定', reloaded.verdict('s3', 'u1') === 'other')
  check('unowned 判定', reloaded.verdict('s9', 'u1') === 'unowned')
  check('按用户列举', reloaded.sessionsOfUser('u1').length === 2)
  reloaded.release('s1')
  check('解除归属', reloaded.ownerOfSession('s1') === undefined)

  console.log('SQLite 用户库')
  const dir = await DatabaseUserDirectory.connect({ engine: 'sqlite', filename: 'users.sqlite' }, DEFAULT_AUTH.scryptCost)
  const created = await dir.create({ username: 'bob', password: 'password123', displayName: 'Bob', role: 'user' })
  check('创建用户', created.username === 'bob' && created.role === 'user')
  check('重复用户名报错', await dir.create({ username: 'bob', password: 'password123' }).then(() => false, () => true))
  check('弱口令报错', await dir.create({ username: 'carl', password: '123' }).then(() => false, () => true))
  check('认证通过', (await dir.authenticate('bob', 'password123'))?.username === 'bob')
  check('错误口令拒绝', (await dir.authenticate('bob', 'nope')) === null)
  check('不存在用户拒绝', (await dir.authenticate('nobody', 'x')) === null)
  check('列出用户', (await dir.list()).length === 1)

  await dir.changePassword(created.id, 'password123', 'newpassword1')
  check('改口令后新口令可用', (await dir.authenticate('bob', 'newpassword1')) !== null)
  check('改口令后旧口令失效', (await dir.authenticate('bob', 'password123')) === null)
  check('旧口令改密被拒', await dir.changePassword(created.id, 'password123', 'another123').then(() => false, () => true))

  await dir.update(created.id, { role: 'admin', disabled: true })
  const disabled = (await dir.list())[0]
  check('更新角色', disabled.role === 'admin')
  check('停用后无法登录', (await dir.authenticate('bob', 'newpassword1')) === null)
  await dir.remove(created.id)
  check('删除用户', (await dir.list()).length === 0)
  await dir.close()
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
