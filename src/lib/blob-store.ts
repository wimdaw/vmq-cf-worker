/**
 * EdgeOne Blob 存储原语。
 *
 * 平台没有托管数据库（KV 只在 Edge Functions 可用，而且是 60s 最终一致，
 * 支付系统不能用），所以「表」就建模成 Blob 的 key 前缀，见 blob-db.ts。
 *
 * 这里只封装四件事：读 / 写 / 删 / 列 key，外加两个关键语义：
 *   1. `put(..., { onlyIfNew: true })` —— 条件写，等价于主键冲突检测，
 *      金额池占位、商户订单号唯一性都靠它（原子，不依赖锁）
 *   2. `strong` 一致性 —— 写入后立刻读得到，否则 appPush 标记已支付、
 *      用户马上回跳查单会读到旧状态
 */
import { getStore } from '@edgeone/pages-blob';

export interface BlobStore {
  getText(key: string): Promise<string | null>;
  getBytes(key: string): Promise<Uint8Array | null>;
  /** 返回 false 表示 onlyIfNew 冲突（key 已存在） */
  put(key: string, value: string | Uint8Array, opts?: { onlyIfNew?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  readonly kind: 'edgeone' | 'memory';
}

/* ------------------------------ EdgeOne Blob ------------------------------ */

const STORE_NAME = 'vmq';

function isPreconditionError(e: unknown): boolean {
  const err = e as { name?: string; code?: string; status?: number; message?: string };
  const text = `${err?.name ?? ''} ${err?.code ?? ''} ${err?.message ?? ''}`.toLowerCase();
  return (
    err?.status === 412 ||
    text.includes('precondition') ||
    text.includes('already exists') ||
    text.includes('if-none-match')
  );
}

function createEdgeoneStore(): BlobStore {
  // 每次读取都显式带 consistency: 'strong' —— 字符串形式创建 Store 时默认是 eventual，
  // 只在 get/list 上覆盖才保证「写后立刻读得到」
  const store = getStore(STORE_NAME);

  return {
    kind: 'edgeone',
    async getText(key) {
      return (await store.get(key, { consistency: 'strong' })) ?? null;
    },
    async getBytes(key) {
      const buf = await store.get(key, { type: 'arrayBuffer', consistency: 'strong' });
      return buf ? new Uint8Array(buf) : null;
    },
    async put(key, value, opts) {
      // SDK 的 BlobInput 只收 ArrayBuffer/Blob/string，Uint8Array 要先取出底层缓冲
      const body =
        typeof value === 'string'
          ? value
          : (value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength
            ) as ArrayBuffer);
      try {
        await store.set(key, body, opts?.onlyIfNew ? { onlyIfNew: true } : undefined);
        return true;
      } catch (e) {
        if (opts?.onlyIfNew && isPreconditionError(e)) return false;
        throw e;
      }
    },
    async del(key) {
      await store.delete(key);
    },
    async keys(prefix) {
      const r = await store.list({ prefix, consistency: 'strong' });
      return r.blobs.map((b) => b.key);
    },
  };
}

/* --------------------------- 内存实现（本地开发） --------------------------- */

function createMemoryStore(): BlobStore {
  const map = new Map<string, string | Uint8Array>();
  return {
    kind: 'memory',
    async getText(key) {
      const v = map.get(key);
      return typeof v === 'string' ? v : null;
    },
    async getBytes(key) {
      const v = map.get(key);
      return v instanceof Uint8Array ? v : null;
    },
    async put(key, value, opts) {
      if (opts?.onlyIfNew && map.has(key)) return false;
      map.set(key, value);
      return true;
    },
    async del(key) {
      map.delete(key);
    },
    async keys(prefix) {
      return [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

/* --------------------------------- 选择实现 -------------------------------- */

let cached: BlobStore | null = null;

/**
 * 拿一个 Store 实例（进程内复用）。
 *
 * `VMQ_STORE=memory` 强制用内存实现（本地 dev / 单测）。
 * 否则先试 EdgeOne Blob；拿不到时按 `VMQ_STORE=auto`（默认）降级到内存并打日志，
 * 设成 `edgeone` 则直接抛错 —— 生产环境静默降级会比报错更糟。
 */
export function openStore(): BlobStore {
  if (cached) return cached;

  const mode = (process.env.VMQ_STORE ?? 'auto').toLowerCase();
  if (mode === 'memory') {
    cached = createMemoryStore();
    return cached;
  }

  try {
    cached = createEdgeoneStore();
    return cached;
  } catch (e) {
    if (mode === 'edgeone') throw e;
    console.warn('[blob] EdgeOne Blob 不可用，降级为内存存储（重启即丢）：', String(e).slice(0, 160));
    cached = createMemoryStore();
    return cached;
  }
}

/** 测试用：清掉进程内缓存 */
export function resetStore(): void {
  cached = null;
}
