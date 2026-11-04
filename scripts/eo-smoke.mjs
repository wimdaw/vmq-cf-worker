/**
 * 把 test/edgeone.smoke.ts 打成单文件再跑 —— 这样内存 store 与入口在同一个进程里，
 * 不需要额外启动服务，也不需要装 TS 运行时。
 *
 *   pnpm eo:smoke
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.tmp', 'smoke.mjs');

rmSync(join(root, '.tmp'), { recursive: true, force: true });
mkdirSync(join(root, '.tmp'), { recursive: true });

/** 有构建产物就用真的外壳，这样冒烟也能覆盖「注入站点配置」这段 */
const shells = {};
for (const f of ['index.html', 'doc.html', 'api.html', 'demo.html', 'result.html', 'chaorder.html']) {
  const p = join(root, 'public/site', f);
  if (existsSync(p)) shells[`/site/${f}`] = readFileSync(p, 'utf8');
}
if (existsSync(join(root, 'public/console/index.html'))) {
  shells['/console/index.html'] = readFileSync(join(root, 'public/console/index.html'), 'utf8');
}

const esbuild = await import('esbuild').catch(() =>
  import(new URL('../node_modules/esbuild/lib/main.js', import.meta.url).href)
);

await esbuild.build({
  entryPoints: [join(root, 'test/edgeone.smoke.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  plugins: [
    {
      name: 'vmq-shells',
      setup(build) {
        build.onResolve({ filter: /^virtual:vmq-shells$/ }, () => ({ path: 's', namespace: 'vmq' }));
        build.onLoad({ filter: /.*/, namespace: 'vmq' }, () => ({
          contents: `export const SHELLS = ${JSON.stringify(shells)};`,
          loader: 'js',
        }));
      },
    },
  ],
  logLevel: 'warning',
});

const r = spawnSync(process.execPath, [out], {
  stdio: 'inherit',
  env: { ...process.env, VMQ_STORE: 'memory' },
});
rmSync(join(root, '.tmp'), { recursive: true, force: true });
process.exit(r.status ?? 1);
