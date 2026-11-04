/**
 * 后台别名解析（adminAlias / primeAdminAlias）。
 *
 * 两条来源必须都成立：
 *   · env.ADMIN_ALIAS 配了 → 直接用，**不查库**（线上跑的就是这条，零额外开销）
 *   · env 没配 → 从 config.admin_alias 读，缓存 60 秒（开源版首次安装由 /setup 写入）
 *
 * EdgeOne 版没有 D1，配置存在 Blob（`cfg` 这个 key 上的一个 JSON 文档），
 * 所以这里用内存实现的 Blob Store 代替以前伪造的 `env.DB.prepare()`。
 */
process.env.VMQ_STORE = 'memory';

const { adminAlias, primeAdminAlias, setAdminAliasCache } = await import('../src/lib/db.ts');
const { saveConfig } = await import('../src/lib/blob-db.ts');

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (期望 ${JSON.stringify(want)})`}`);
}

console.log('别名解析');

// 1) env 优先：即使配置里是别的值，也用 env
await saveConfig([['admin_alias', 'from-db']]);
const envWithVar = { ADMIN_ALIAS: 'my-admin-alias' };
await primeAdminAlias(envWithVar);
check('env 优先', adminAlias(envWithVar), 'my-admin-alias');

// 2) env 带首尾斜杠/非法字符 → 归一化
check('归一化', adminAlias({ ADMIN_ALIAS: '/my-vault_1/' }), 'my-vault_1');
check('非法字符剔除', adminAlias({ ADMIN_ALIAS: '后台入口' }), 'admin');
check('空串回退', adminAlias({ ADMIN_ALIAS: '' }), 'admin');

// 3) env 没配 → 从配置读（模拟 /setup 写入后的冷启动）
//    缓存还是空的（第 1 步因为 env 配了直接 return，没写缓存）
check('prime 前回退默认', adminAlias({}), 'admin');
await saveConfig([['admin_alias', 'myvault']]);
await primeAdminAlias({}, true); // force：跳过缓存，模拟冷启动
check('prime 后用配置里的值', adminAlias({}), 'myvault');

// 4) 配置里没有这个键（尚未初始化）→ 回退 admin，且不抛异常
await saveConfig([['admin_alias', '']]);
await primeAdminAlias({}, true); // 不应 throw
check('未初始化不抛错', adminAlias({}), 'admin');

// 5) /setup 写完立即生效，不用等 60 秒缓存过期
setAdminAliasCache('/vault9/');
check('setAdminAliasCache 立即生效', adminAlias({}), 'vault9');

if (failed) {
  console.error(`别名解析失败 ${failed} 项`);
  process.exit(1);
}
console.log('全部通过（别名解析 8 项）');
