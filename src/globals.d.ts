/**
 * 虚拟模块声明：`virtual:vmq-shells` 由 scripts/eo-build.mjs 在打包时注入，
 * 内容是从 public/ 里读出来的 HTML 外壳，键是站内绝对路径。
 */
declare module 'virtual:vmq-shells' {
  export const SHELLS: Record<string, string>;
}

/** EdgeOne 的 Node 运行时通过 process.env 提供环境变量；这里只用到这一小部分 */
declare const process: {
  env: Record<string, string | undefined>;
};
