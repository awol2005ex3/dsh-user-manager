/**
 * 独立登录页。浏览器半的遮罩也可以完成登录，这一页是给"整页登录"场景
 * 用的（例如在外部入口直接跳过来），样式不依赖前端应用。
 */

/** 渲染登录页 HTML。 */
export function renderLoginPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · DeepSeek Harness</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #16181d; color: #e6e6e6;
    font: 14px/1.6 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .card { width: 340px; padding: 28px; background: #1e2128; border: 1px solid #2e323b; border-radius: 12px; }
  h1 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
  p.sub { margin: 0 0 20px; font-size: 12px; color: #8b919c; }
  label { display: block; margin-bottom: 14px; font-size: 12px; color: #a8b0bd; }
  input {
    width: 100%; box-sizing: border-box; margin-top: 6px; padding: 9px 11px;
    background: #14161b; border: 1px solid #343944; border-radius: 8px;
    color: #e6e6e6; font-size: 14px; outline: none;
  }
  input:focus { border-color: #4d7cfe; }
  button {
    width: 100%; margin-top: 6px; padding: 10px; font-size: 14px; cursor: pointer;
    background: #4d7cfe; color: #fff; border: none; border-radius: 8px;
  }
  button:hover { background: #5c88ff; }
  button:disabled { background: #3a4252; cursor: not-allowed; }
  .err { margin-top: 14px; min-height: 18px; font-size: 12px; color: #ff7b72; }
</style>
</head>
<body>
<div class="card">
  <h1>DeepSeek Harness</h1>
  <p class="sub">登录后进入你的会话空间</p>
  <form id="form" autocomplete="on">
    <label>用户名<input id="username" name="username" autocomplete="username" autofocus></label>
    <label>密码<input id="password" name="password" type="password" autocomplete="current-password"></label>
    <button id="submit" type="submit">登录</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
  var form = document.getElementById('form');
  var err = document.getElementById('err');
  var submit = document.getElementById('submit');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    submit.disabled = true;
    fetch('/user-manager/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
      })
    }).then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.status === 200 && res.data.ok) { location.replace('/'); return; }
        err.textContent = (res.data && res.data.error) || '登录失败';
        submit.disabled = false;
      })
      .catch(function () {
        err.textContent = '网络错误，请重试';
        submit.disabled = false;
      });
  });
</script>
</body>
</html>
`
}
