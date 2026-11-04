#!/usr/bin/env node
/**
 * 站点域名 → 监控端 App 配置。
 *
 * 盯的是一条很容易错的链路：后台「通道管理」给每个通道生成的
 * 「APP扫码配置 / APP手动配置」字符串必须是
 *
 *     https://域名/通讯密钥/通道id,支付类型     例：https://pay.example.com/3f9a…/8,1
 *
 * （扫码与手动共用同一个字段，所以两者必然一致 —— 这条也在这里断言。）
 *
 * 四处必须同时对，错一处 App 就绑不上或者心跳/推送验签失败：
 *   1. **必须带 https://** —— App 拿它当地址去请求 /appPush，缺协议发不出去
 *   2. 域名优先取后台「站点地址」(config.url)，没配才用当前请求的 origin
 *   3. 密钥必须与 /appPush 验签同源（appSecret：app_key → key → epaykey_ali）
 *   4. 域名或密钥缺一个就整串返回空，不给半截字符串
 */
import { handleSetup } from '../src/routes/setup.ts';
import { listPassages } from '../src/modules/passages/passage.service.ts';
import { appSecret } from '../src/lib/db.ts';
import { monitorSign, verifyMonitor } from '../src/lib/sign.ts';
import { hostOf, originOf } from '../src/lib/util.ts';
import { openStore } from '../src/lib/blob-store.ts';
import { saveConfig, allConfig, countAdmins, invalidateConfigCache, resetDb } from '../src/lib/blob-db.ts';

// 数据层走 Blob，单测用内存实现
process.env.VMQ_STORE = 'memory';

let bad = 0;
function eq(got, want, label) {
  if (got !== want) {
    bad++;
    console.log('FAIL', label, 'got', JSON.stringify(got), 'want', JSON.stringify(want));
  }
}

/* ---------------- hostOf：站点地址的各种手填写法 ---------------- */
eq(hostOf('https://pay.example.com/'), 'pay.example.com', 'hostOf 带协议+尾斜杠');
eq(hostOf('http://pay.example.com'), 'pay.example.com', 'hostOf http');
eq(hostOf('pay.example.com'), 'pay.example.com', 'hostOf 裸域名');
eq(hostOf('pay.example.com/sub/'), 'pay.example.com', 'hostOf 带子路径');
eq(hostOf('https://pay.example.com:8443'), 'pay.example.com:8443', 'hostOf 保留端口');
eq(hostOf('  https://pay.example.com  '), 'pay.example.com', 'hostOf 去首尾空格');
eq(hostOf(''), '', 'hostOf 空串');
eq(hostOf('   '), '', 'hostOf 纯空格');

/* ---------------- originOf：绑定串必须带 https:// ---------------- */
eq(originOf('https://pay.example.com/'), 'https://pay.example.com', 'originOf 已带 https');
eq(originOf('pay.example.com'), 'https://pay.example.com', 'originOf 裸域名补 https');
eq(originOf('pay.example.com/sub/'), 'https://pay.example.com', 'originOf 去路径');
eq(originOf('http://pay.example.com'), 'https://pay.example.com', 'originOf 线上 http 也升级成 https');
eq(originOf('http://localhost:8787'), 'http://localhost:8787', 'originOf 本机保留 http');
eq(originOf('http://127.0.0.1:8787'), 'http://127.0.0.1:8787', 'originOf 127.0.0.1 保留 http');
eq(originOf('localhost:8787'), 'https://localhost:8787', 'originOf 本机但没写 http 就给 https');
eq(originOf(''), '', 'originOf 空串');

/* ---------------- 造数据：把配置和通道写进内存 Blob ----------------
 *
 * EdgeOne 版没有 D1，`listPassages` 从 Blob 的 `ps` 键读通道数组，
 * 所以这里直接往 store 里塞，等价于以前伪造 `env.DB.prepare()`。
 */
async function makeEnv(config = {}, rows = []) {
  const store = openStore();
  await store.del('cfg'); // 每条用例从干净配置开始（否则上一条的 url/key 会串过来）
  invalidateConfigCache(); // 配置有 3 秒进程内缓存，删 key 后必须一起清
  const entries = Object.entries(config).map(([k, v]) => [k, String(v)]);
  if (entries.length) await saveConfig(entries);
  if (rows.length) {
    const docs = rows.map((r) => ({
      hang_free: 0,
      cookie: '',
      update_time: r.create_time,
      ...r,
    }));
    await store.put('ps', JSON.stringify(docs));
  }
  return {};
}

const ROW = {
  id: 8,
  type: 1,
  code: 0,
  zf_pid: '',
  ewm_type: 0,
  ewm: 'wxp://demo',
  balance: '0',
  succcount: 0,
  succprice: '0',
  is_status: 0,
  status: 1,
  money_change: 0,
  pay_qf: 0,
  create_time: 0,
  run_time: 0,
  remarks: 'demo',
};

/** 取第一行生成的 APP 扫码配置 */
async function appConfigOf(config, reqHost = '') {
  const res = await listPassages(await makeEnv(config, [ROW]), { limit: '10' }, reqHost);
  return res.data[0].app_config;
}

/* ---------------- 域名：优先 config.url，且必须剥掉协议 ---------------- */
eq(
  await appConfigOf({ url: 'https://pay.example.com/', key: 'KEY123' }),
  'https://pay.example.com/KEY123/8,1',
  '绑定串带 https:// 协议'
);
eq(
  await appConfigOf({ url: 'https://pay.example.com/vmq/', key: 'KEY123' }),
  'https://pay.example.com/KEY123/8,1',
  '站点地址带子路径只取域名'
);
eq(
  await appConfigOf({ url: 'pay.example.com', key: 'KEY123' }),
  'https://pay.example.com/KEY123/8,1',
  '站点地址没写协议也能补上 https'
);
eq(
  await appConfigOf({ key: 'KEY123' }, 'https://p9.example.workers.dev'),
  'https://p9.example.workers.dev/KEY123/8,1',
  '未配站点地址时用请求 origin 兜底'
);
eq(
  await appConfigOf({ url: 'https://pay.example.com/', key: 'KEY123' }, 'https://p9.example.workers.dev'),
  'https://pay.example.com/KEY123/8,1',
  '配了站点地址就优先于请求 origin'
);
// 管理员是用 http 打开后台的（没开 Always Use HTTPS）：绑定串仍必须是 https
eq(
  await appConfigOf({ key: 'KEY123' }, 'http://pay.example.com'),
  'https://pay.example.com/KEY123/8,1',
  'http 访问也生成 https 绑定串'
);
// 本机调试地址保留 http，否则本地根本连不上
eq(
  await appConfigOf({ url: 'http://localhost:8787', key: 'KEY123' }),
  'http://localhost:8787/KEY123/8,1',
  '本机调试保留 http'
);

/* ---------------- 密钥：取值顺序必须和 /appPush 验签一致 ---------------- */
eq(
  await appConfigOf({ url: 'https://pay.example.com/', app_key: 'NEW', key: 'OLD' }),
  'https://pay.example.com/NEW/8,1',
  'app_key 优先于 key'
);
eq(
  await appConfigOf({ url: 'https://pay.example.com/', epaykey_ali: 'LEGACY' }),
  'https://pay.example.com/LEGACY/8,1',
  '只剩历史 epaykey_ali 也能用'
);

// 拿列表里的密钥去签一次 appPush，必须和 /appPush 的验签对得上
{
  const env = await makeEnv({ url: 'https://pay.example.com/', key: 'PUSHKEY' }, [ROW]);
  const cfg = (await listPassages(env, { limit: '10' }, '')).data[0].app_config;
  // 'https://host/KEY/8,1' → 取 path 第一段
  const emittedKey = new URL(cfg).pathname.split('/')[1];
  const t = '1761900000';
  const pid = '8';
  const sign = monitorSign([t, pid], emittedKey); // App 端心跳签名
  eq(verifyMonitor([t, pid], sign, await appSecret(env)), true, '扫码配置里的密钥能过 /appHeart 验签');
}

/* ---------------- 缺域名或密钥 → 给空串，别给半截字符串 ---------------- */
eq(await appConfigOf({ url: 'https://pay.example.com/' }, 'https://req.example.com'), '', '没配密钥返回空');
eq(await appConfigOf({ key: 'KEY123' }, ''), '', '域名也没认到时返回空');

/* ---------------- /setup：初始化要顺手把站点地址写进 config ---------------- */
{
  const form = new URLSearchParams({
    username: 'boss_ok',
    password: 'Aa12345678',
    password2: 'Aa12345678',
    alias: 'myvault',
    sitename: '演示站',
  });

  // 每次 POST 前换一个空 store：/setup 只在「还没建管理员」时可写
  resetDb();
  const env = {};

  // 表单页：两个密码框都要有「小眼睛」，且默认只显示睁眼那个图标
  const formHtml = await (await handleSetup(
    new Request('https://pay.example.com/setup', { method: 'GET' }),
    env
  )).text();
  eq((formHtml.match(/data-pw-toggle=/g) ?? []).length, 2, '两个密码框都有小眼睛');
  eq(
    formHtml.includes('.pw-toggle .eye-off{display:none}'),
    true,
    '闭眼图标默认隐藏（用 display 控制 —— SVG 上的 hidden 属性在 Chrome 不生效）'
  );
  eq(
    /<button type="button" class="pw-toggle"/.test(formHtml),
    true,
    '小眼睛是 type=button，不会误提交表单'
  );

  const res = await handleSetup(
    new Request('https://pay.example.com/setup', { method: 'POST', body: form }),
    env
  );
  eq(res.status, 302, '/setup 提交后 302 跳转');
  eq(
    res.headers.get('location'),
    'https://pay.example.com/myvault/login',
    '/setup 跳到登录页（带别名）'
  );

  // 断言落在真实存储上（EdgeOne 版配置是 Blob 里的一个 JSON 文档）
  const kv = await allConfig();
  eq(kv['url'], 'https://pay.example.com', '/setup 写入站点地址（不含尾斜杠）');
  eq(kv['title'], '演示站', '/setup 写入站点名称');
  eq(kv['admin_alias'], 'myvault', '/setup 写入后台别名');
  eq(await countAdmins(), 1, '/setup 建管理员');
  eq(/^\d{10}$/.test(kv['epayid_ali'] ?? ''), true, '/setup 自动生成 10 位商户 ID', String(kv['epayid_ali']));
  eq(kv['epayurl_ali'], 'https://pay.example.com', '/setup 落库支付网关地址');

  // 反代场景：对外域名只在 X-Forwarded-Host 里，不能把站点自己的域名写进去
  resetDb();
  const res2 = await handleSetup(
    new Request('https://vmq.internal.example.com/setup', {
      method: 'POST',
      body: form,
      headers: { 'x-forwarded-host': 'pay.example.com', 'x-forwarded-proto': 'https' },
    }),
    env
  );
  const kv2 = await allConfig();
  eq(kv2['url'], 'https://pay.example.com', '/setup 认 X-Forwarded-Host');
  eq(kv2['epayurl_ali'], 'https://pay.example.com', '网关地址也用对外域名');
  eq(
    res2.headers.get('location'),
    'https://pay.example.com/myvault/login',
    '跳转地址也用对外域名'
  );
}

console.log(bad === 0 ? '✓ 站点域名 / APP 配置全部通过' : `✗ ${bad} 项失败`);
if (bad) process.exit(1);
