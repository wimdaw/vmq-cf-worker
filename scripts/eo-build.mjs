/**
 * EdgeOne 构建脚本。
 *
 * 干四件事：
 *   1. 把前台/后台构建产物里的 **静态文件** 复制到 dist/（`/static`、`/site/assets`、`/console/assets`）
 *   2. 把 7 个 HTML 外壳读进内存，打包时以虚拟模块内嵌进函数
 *      —— 平台的静态资源优先于函数，外壳一旦落成静态文件，请求就永远进不了函数，
 *         站点配置也就注入不进去
 *   3. 用 esbuild 把 src/edgeone-entry.ts 打成 cloud-functions/[[default]].js
 *   4. 生成 cloud-functions/index.js（`/` 这个根路径要单独一个入口文件）
 *
 * 产物：
 *   dist/                         静态站根目录（edgeone.json 的 outputDirectory）
 *   cloud-functions/[[default]].js 兜底路由（所有动态路径）
 *   cloud-functions/index.js       `/`
 */
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const p = (...xs) => join(root, ...xs);

/** 前台页面外壳：这些必须由函数渲染（要注入标题/描述/静态资源基址） */
const SITE_PAGES = ['index.html', 'doc.html', 'api.html', 'demo.html', 'result.html', 'chaorder.html'];

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

/* ------------------------- 1) 收集 HTML 外壳 ------------------------- */

const shells = {};
for (const f of SITE_PAGES) {
  const file = p('public/site', f);
  if (!existsSync(file)) fail(`缺少前台产物 public/site/${f}，先跑 pnpm web:build`);
  shells[`/site/${f}`] = readFileSync(file, 'utf8');
}
const consoleShell = p('public/console/index.html');
if (!existsSync(consoleShell)) fail('缺少后台产物 public/console/index.html，先跑 pnpm admin:build');
shells['/console/index.html'] = readFileSync(consoleShell, 'utf8');

/* --------------------------- 2) 复制静态资源 --------------------------- */

const dist = p('dist');
try {
  rmSync(dist, { recursive: true, force: true });
} catch {
  // 容错：若遇受保护沙箱或文件锁，确保目录存在即可
}
if (!existsSync(dist)) {
  mkdirSync(dist, { recursive: true });
}

/** 只复制目录内容，不复制 HTML（外壳走函数） */
function copyDir(from, to) {
  if (!existsSync(from)) return 0;
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !src.endsWith('.html'),
  });
  return 1;
}

copyDir(p('public/static'), p('dist/static'));
copyDir(p('public/site'), p('dist/site'));
copyDir(p('public/console'), p('dist/console'));
if (existsSync(p('public/favicon.ico'))) cpSync(p('public/favicon.ico'), p('dist/favicon.ico'));

/* --------------------------- 3) 打包函数 --------------------------- */

const esbuild = await import('esbuild').catch(() =>
  import(new URL('../node_modules/esbuild/lib/main.js', import.meta.url).href)
);

const shellsPlugin = {
  name: 'vmq-shells',
  setup(build) {
    build.onResolve({ filter: /^virtual:vmq-shells$/ }, () => ({ path: 'vmq-shells', namespace: 'vmq' }));
    build.onLoad({ filter: /.*/, namespace: 'vmq' }, () => ({
      contents: `export const SHELLS = ${JSON.stringify(shells)};`,
      loader: 'js',
    }));
  },
};

const outdir = p('cloud-functions');
mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [p('src/edgeone-entry.ts')],
  outfile: join(outdir, '[[default]].js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  plugins: [shellsPlugin],
  // 依赖全部打进来：部署包里不需要 node_modules，函数体积也只看这一个文件
  external: [],
  legalComments: 'none',
  minify: true,
  logLevel: 'info',
});

// 根路径 `/` 单独一个入口文件（[[param]] 兜底只匹配一段以上路径）
writeFileSync(
  join(outdir, 'index.js'),
  "export { onRequest, default } from './[[default]].js';\n",
  'utf8'
);

/* ---------------------------- 4) 汇总 ---------------------------- */

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of require('node:fs').readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else total += require('node:fs').statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

const fnBytes = require('node:fs').statSync(join(outdir, '[[default]].js')).size;
console.log(`\n✓ 函数包 cloud-functions/[[default]].js  ${(fnBytes / 1024).toFixed(0)} KB`);
console.log(`✓ 静态资源 dist/  ${(dirSize(dist) / 1024).toFixed(0)} KB`);
console.log(`✓ 内嵌外壳 ${Object.keys(shells).length} 个（${Object.keys(shells).join(', ')}）`);
if (fnBytes > 5 * 1024 * 1024) {
  console.log('⚠️  函数包超过 5MB，Edge Functions 会拒绝，但 Cloud Functions(Node) 上限是 128MB');
}
