/**
 * 首次初始化向导（替代 PHP 版的 install 目录）。
 *
 * 设计约束：
 *   1. **只在没有任何管理员时可用** —— 线上已有管理员，访问 /setup 直接 404，
 *      所以这个文件对已运行的实例完全透明。
 *   2. 初始化完成后永久关闭（管理员存在即不可用），不存在"重置"入口。
 *   3. 通讯密钥 / admin_secret / cron_key 全部**随机生成**，不用文档里的默认值
 *      —— 参考项目把 admin123 写进 README，那是最大的安全隐患。
 *   4. 可选 `SETUP_TOKEN`：配了就要求 URL 带同样的 token，防别人抢先初始化。
 *
 * 前置条件：已经执行过 `wrangler d1 execute <db> --file=schema.sql --remote`（表存在）。
 */
import type { Env } from '../lib/db';
import { setAdminAliasCache } from '../lib/db';
import { hashPassword } from '../lib/auth';
import { externalHost, externalProto, html, publicUrl, randHex, text } from '../lib/util';
import { countAdmins as blobCountAdmins, getConfigs, insertAdmin, saveConfig } from '../lib/blob-db';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STYLE = `
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:#f5f6f8;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:#1f2329;padding:24px}
    .card{width:100%;max-width:520px;background:#fff;border-radius:14px;padding:32px 32px 26px;
          box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px -12px rgba(16,24,40,.16)}
    h1{margin:0 0 6px;font-size:19px;font-weight:500}
    .sub{margin:0 0 22px;color:#6b7280;font-size:13px}
    label{display:block;margin:14px 0 6px;font-size:13px;color:#374151}
    input{width:100%;height:38px;padding:0 12px;border:1px solid #d8dbe0;border-radius:8px;font-size:14px;outline:none}
    input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
    .hint{margin-top:5px;font-size:12px;color:#9aa1ac}
    /* 密码框：右侧留出眼睛按钮的位置 */
    .pw{position:relative}
    .pw input{padding-right:42px}
    .pw-toggle{position:absolute;right:5px;top:50%;transform:translateY(-50%);
               width:30px;height:30px;margin:0;padding:0;border:0;border-radius:6px;
               display:flex;align-items:center;justify-content:center;
               background:transparent;color:#9aa1ac;cursor:pointer}
    .pw-toggle:hover{color:#374151;background:#f3f4f6}
    .pw-toggle:focus-visible{outline:2px solid #93b4f7;outline-offset:1px}
    .pw-toggle svg{width:18px;height:18px}
    /* 默认只显示睁眼；闭眼由脚本切显（SVG 上挂 hidden 属性在 Chrome 里不生效，
       所以统一用 display 控制，别改成 hidden） */
    .pw-toggle .eye-off{display:none}
    button{width:100%;height:40px;margin-top:22px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:14px;cursor:pointer}
    button:hover{background:#1d4ed8}
    .err{margin:0 0 16px;padding:10px 12px;border-radius:8px;background:#fef2f2;color:#b91c1c;font-size:13px}
    .ok{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 18px;margin-top:6px}
    .ok b{font-weight:500}
    code{background:#f3f4f6;padding:2px 6px;border-radius:5px;font-size:13px;word-break:break-all}
    a{color:#2563eb;text-decoration:none}
`;

function page(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><div class="card">${body}</div></body></html>`;
}

/** 眼睛图标：默认睁眼（点击后明文），切到明文后换成闭眼 */
const EYE_ON = `<svg class="eye-on" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2 12s3.6-7 10-7c1.6 0 3 .4 4.3 1.1M22 12s-3.6 7-10 7c-1.6 0-3-.4-4.3-1.1"/>
  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>`;

/**
 * 带「小眼睛」的密码框：点击在明文/密文之间切换。
 *
 * 这个页面是服务端直出的 HTML，用不了后台那套 React 的 PasswordInput，
 * 所以这里用原生 button + 几行内联脚本实现，不引任何依赖。
 */
function pwField(id: string, name: string, label: string, hint = ''): string {
  return `<label for="${id}">${label}</label>
      <div class="pw">
        <input id="${id}" name="${name}" type="password" autocomplete="new-password" required>
        <button type="button" class="pw-toggle" data-pw-toggle="${id}"
                aria-label="显示密码" aria-pressed="false" title="显示密码">${EYE_ON}${EYE_OFF}</button>
      </div>${hint ? `\n      <div class="hint">${hint}</div>` : ''}`;
}

/** 切换密码可见性；用事件委托写法兼容多次渲染，也不依赖任何框架 */
const PW_SCRIPT = `<script>
(function () {
  var btns = document.querySelectorAll('[data-pw-toggle]');
  Array.prototype.forEach.call(btns, function (btn) {
    btn.addEventListener('click', function () {
      var input = document.getElementById(btn.getAttribute('data-pw-toggle'));
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      btn.setAttribute('title', show ? '隐藏密码' : '显示密码');
      var on = btn.querySelector('.eye-on');
      var off = btn.querySelector('.eye-off');
      if (on) on.style.display = show ? 'none' : 'block';
      if (off) off.style.display = show ? 'block' : 'none';
      input.focus();
    });
  });
})();
</script>`;

function formPage(token: string, err = '', v: Record<string, string> = {}): string {
  const val = (k: string, d = '') => esc(v[k] ?? d);
  return page(
    '初始化 · V免签',
    `<h1>初始化 V免签</h1>
    <p class="sub">第一次运行需要创建管理员并生成密钥。完成后本页面会永久关闭。</p>
    ${err ? `<p class="err">${esc(err)}</p>` : ''}
    <form method="post" action="/setup">
      ${token ? `<input type="hidden" name="token" value="${esc(token)}">` : ''}
      <label for="username">管理员账号</label>
      <input id="username" name="username" value="${val('username', 'admin')}" autocomplete="username" required>
      <div class="hint">3–20 位，字母数字下划线</div>

      ${pwField('password', 'password', '登录密码', '至少 8 位')}

      ${pwField('password2', 'password2', '确认密码')}

      <label for="alias">后台入口别名</label>
      <input id="alias" name="alias" value="${val('alias', 'admin')}" required>
      <div class="hint">后台会挂在 <code>/{别名}</code>。建议别用 admin，改成只有你知道的字符串（之后可在 config 表调整）</div>

      <label for="sitename">站点名称</label>
      <input id="sitename" name="sitename" value="${val('sitename', 'V免签')}" required>

      <button type="submit">完成初始化</button>
    </form>
    ${PW_SCRIPT}`
  );
}

/** 表还没建：「先跑 schema.sql」比 500 堆栈友好得多 */
function notReadyPage(): string {
  return page(
    '数据库未初始化',
    `<h1>数据库还没建表</h1>
     <p class="sub">先执行下面这条命令，再刷新本页：</p>
     <p><code>wrangler d1 execute vmq --file=./schema.sql --remote</code></p>
     <p class="hint">不加 <code>--remote</code> 只建本地模拟库，线上仍然是空的。</p>`
  );
}

async function countAdmins(env: Env): Promise<number> {
  void env;
  return blobCountAdmins();
}

export async function handleSetup(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const token = env.SETUP_TOKEN ?? '';

  const count = await countAdmins(env);
  // 已初始化（线上走这里）→ 一律 404，不暴露任何信息
  if (count > 0) return text('Not Found', 404);

  // 配了 SETUP_TOKEN 就必须带对，否则当作不存在。
  // 令牌有两个来源：查询串（首次访问 `/setup?token=…`）与表单隐藏域（提交时）。
  // 表单的 action 是 `/setup`，提交时**查询串会丢掉**，只剩 body 里的 token，
  // 所以这里必须同时认 body —— 否则 POST 一律 404，表现就是「填完点提交没有反应」。
  let provided = url.searchParams.get('token') ?? '';
  if (!provided && req.method === 'POST') {
    try {
      // clone 一份来读，避免把原始 body 消耗掉
      provided = String((await req.clone().formData()).get('token') ?? '');
    } catch {
      /* 解析失败留空，下面按未授权处理 */
    }
  }
  if (token && provided !== token) return text('Not Found', 404);

  if (req.method === 'GET') return html(formPage(url.searchParams.get('token') ?? token));

  if (req.method !== 'POST') return text('Method Not Allowed', 405);

  let f: FormData;
  try {
    f = await req.formData();
  } catch {
    return html(formPage(token, '表单解析失败，请重试'));
  }
  const g = (k: string) => String(f.get(k) ?? '').trim();
  const username = g('username');
  const password = g('password');
  const password2 = g('password2');
  const alias = g('alias') || 'admin';
  const sitename = g('sitename') || 'V免签';

  const back = { username, alias, sitename };
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return html(formPage(token, '账号需 3–20 位字母数字下划线', back));
  if (password.length < 8) return html(formPage(token, '密码至少 8 位', back));
  if (password !== password2) return html(formPage(token, '两次输入的密码不一致', back));
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(alias)) return html(formPage(token, '别名 2–32 位，仅字母数字、下划线、短横线', back));
  if (sitename.length > 30) return html(formPage(token, '站点名称不超过 30 字', back));

  // 并发保护：再查一次，避免两个人同时提交建出两个管理员
  const recheck = await countAdmins(env);
  if (recheck > 0) return text('Not Found', 404);

  // 已经有值的密钥不重新生成 —— 忘记密码时走"清空管理员 → 重新 /setup"这条路，
  // 通讯密钥必须保持不变，否则监控端要重新绑定、历史订单的验签也会对不上。
  const have = await getConfigs(['key', 'admin_secret', 'cron_key', 'epayid_ali']);

  const commKey = have['key'] || randHex(16); // 通讯密钥（appPush 验签）
  const adminSecret = have['admin_secret'] || randHex(16); // 会话/验证码签名
  const cronKey = have['cron_key'] || randHex(16); // 兼容旧版的"监控密钥"字段
  // 商户 ID（pid）：商户下单时必传、且要写进回调，但服务端不做比对，本质上是个
  // 约定值的凭证。以前留空让用户自己编，现在装的时候就生成一个 10 位数字。
  const epayId = have['epayid_ali'] || String(Math.floor(1e9 + Math.random() * 9e9));
  // 对外域名：监控端扫码配置、支付网关地址都用它；认 X-Forwarded-Host，
  // 反代场景下不会把 Worker 自己的域名写进去。
  const siteUrl = `${externalProto(req)}://${externalHost(req)}`;
  const pwHash = await hashPassword(password);
  const ts = Math.floor(Date.now() / 1000);

  const cfg: [string, string][] = [
    ['setup_done', '1'],
    ['admin_alias', alias],
    ['key', commKey],
    ['admin_secret', adminSecret],
    ['cron_key', cronKey],
    ['title', sitename],
    ['url', siteUrl],
    ['epayid_ali', epayId],
    // 支付网关地址就是本站地址，先落库一份，商户接入时按这个填，不用靠界面占位符猜
    ['epayurl_ali', siteUrl],
  ];

  try {
    await insertAdmin({
      username,
      passwordHash: pwHash,
      role: 1,
      status: 1,
    });
    await saveConfig(cfg);
  } catch (e) {
    return html(formPage(token, `写入失败：${String(e).slice(0, 160)}`, back));
  }

  setAdminAliasCache(alias);
  // 初始化完成直接进登录页：密钥等配置都在后台「系统配置 → 密钥管理」里，
  // 不再中间插一页只显示一次的「初始化完成」（容易让人以为密钥丢了就找不回来）。
  return Response.redirect(publicUrl(req, `/${alias}/login`), 302);
}
