/**
 * Blob 上的数据层 —— EdgeOne 版没有 D1，这里用「key 前缀 + JSON 文档」建模原表。
 *
 * 键空间（全部走 EdgeOne Blob 强一致读）：
 *
 *   cfg                    全站配置 {k: v}（一次读全量，读多写少，进程内缓存）
 *   mon                    监控端状态 {last_heart, last_pay}
 *   o/<order_id>           订单全文
 *   ou/<out_trade_no>      → order_id（onlyIfNew 写入 = 商户订单号唯一）
 *   oi/<id>                → order_id（后台按自增 id 操作）
 *   pool/<分>-<类型>        → order_id（onlyIfNew 写入 = 金额池互斥，替代 INSERT OR IGNORE）
 *   poolby/<order_id>      → pool key（关单/支付后释放）
 *   odx/<YYYY-MM>          当月订单摘要数组（订单列表、看板统计的唯一数据源）
 *   nt/<id>                回调任务
 *   ntq/<next_at>-<id>     回调到期索引（有序 key，扫前缀即可拿最早到期）
 *   ps                     通道数组（含 succcount / succprice）
 *   ad                     管理员数组
 *   lg/<uid>/<时间>-<随机>  操作日志（uid 进 key，按用户筛选时不必全表扫）
 *   up/<hash>              上传图片二进制
 *   upm/<hash>             图片元信息 {mime, size}
 *   um/<时间>-<随机>        未匹配到订单的到账推送
 *   lk/<name>              租约锁
 *
 * 几个刻意的取舍：
 *
 *   · **统计不做增量计数**，全部从 `odx/*` 摘要现算（进程内缓存 5 秒）。
 *     增量计数一旦漏写就会长期偏差，而且删单、补单、回调重试都要同步维护；
 *     按现在的个人收款量级，一个月摘要也就几十 KB，现算更可靠。
 *   · **金额池 / 订单号唯一性用条件写**，不靠锁 —— 这是唯一必须原子的地方，
 *     Blob 的 onlyIfNew 等价于主键冲突，比应用层锁可靠。
 *   · 摘要数组的读改写用租约锁串行，锁粒度是「当月」，不是全表。
 */
import { openStore, resetStore, type BlobStore } from './blob-store';
import type { AdminDoc, OrderRow, PassageRow } from './types';
import { now } from './util';

export type { AdminDoc };

/* ------------------------------- 基础工具 ------------------------------- */

/**
 * 取 store。不在这一层再缓存一次 —— `openStore()` 自己就是进程内单例，
 * 这里多存一层会导致 `resetStore()` 清不干净（本地测试会串数据）。
 */
function s(): BlobStore {
  return openStore();
}

/** 测试/本地重置用：清 store 与所有进程内缓存 */
export function resetDb(): void {
  resetStore();
  cfgCache = null;
  shardCache.clear();
}

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await s().getText(key);
  if (raw === null || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await s().put(key, JSON.stringify(value));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 租约锁：Blob 没有事务，read-modify-write 必须串行。
 *
 * 抢锁用 onlyIfNew；释放前比对 token，避免锁过期被抢占后误删别人的锁。
 */
async function withLock<T>(name: string, fn: () => Promise<T>, ttlMs = 15_000): Promise<T> {
  const key = `lk/${name}`;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + 8_000;

  for (;;) {
    const ok = await s().put(key, token, { onlyIfNew: true });
    if (ok) break;
    const cur = await s().getText(key);
    const at = Number((cur ?? '').split('-')[0]);
    if (cur && Number.isFinite(at) && Date.now() - at > ttlMs) {
      await s().del(key); // 锁过期（持锁进程已挂），清掉再抢
      continue;
    }
    if (Date.now() > deadline) throw new Error(`lock timeout: ${name}`);
    await sleep(20 + Math.floor(Math.random() * 40));
  }

  try {
    return await fn();
  } finally {
    const cur = await s().getText(key);
    if (cur === token) await s().del(key);
  }
}

/** 上海时区的「天序号」，与统计口径一致 */
export function dayKeyOf(ts: number): number {
  return Math.floor((ts + 8 * 3600) / 86400);
}

function ymOf(ts: number): string {
  const d = new Date((ts + 8 * 3600) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* ================================ 站点配置 ================================ */

type ConfigMap = Record<string, string>;
let cfgCache: { at: number; map: ConfigMap } | null = null;
const CFG_TTL_MS = 3_000;

export async function allConfig(): Promise<ConfigMap> {
  if (cfgCache && Date.now() - cfgCache.at < CFG_TTL_MS) return cfgCache.map;
  const map = (await readJson<ConfigMap>('cfg')) ?? {};
  cfgCache = { at: Date.now(), map };
  return map;
}

export async function getConfig(key: string, def = ''): Promise<string> {
  const v = (await allConfig())[key];
  return v ?? def;
}

export async function getConfigs(keys: string[]): Promise<ConfigMap> {
  const all = await allConfig();
  const out: ConfigMap = {};
  for (const k of keys) if (all[k] !== undefined) out[k] = all[k]!;
  return out;
}

export async function saveConfig(entries: Array<[string, string]>): Promise<void> {
  if (!entries.length) return;
  await withLock('cfg', async () => {
    const map = (await readJson<ConfigMap>('cfg')) ?? {};
    for (const [k, v] of entries) map[k] = v;
    await writeJson('cfg', map);
    cfgCache = { at: Date.now(), map };
  });
}

/** 测试/本地重置用 */
export function invalidateConfigCache(): void {
  cfgCache = null;
}

/* ============================== 监控端状态 =============================== */

export interface MonitorDoc {
  last_heart: number;
  last_pay: number;
}

export async function getMonitor(): Promise<MonitorDoc> {
  const doc = await readJson<Partial<MonitorDoc>>('mon');
  return { last_heart: Number(doc?.last_heart ?? 0), last_pay: Number(doc?.last_pay ?? 0) };
}

export async function setMonitor(patch: Partial<MonitorDoc>): Promise<void> {
  const cur = await getMonitor();
  await writeJson('mon', { ...cur, ...patch });
}

/* ================================ 金额池 ================================= */

/**
 * 抢占金额占位。`pool/<分>-<类型>` 用条件写，等价于原表的
 * `INSERT OR IGNORE` + 主键冲突检测：抢不到就是这一分钱已经被占了。
 */
export async function acquirePool(fen: number, type: number, orderId: string): Promise<boolean> {
  const key = `pool/${fen}-${type}`;
  const ok = await s().put(key, orderId, { onlyIfNew: true });
  if (ok) await s().put(`poolby/${orderId}`, key);
  return ok;
}

export async function releasePool(orderId: string): Promise<void> {
  const key = await s().getText(`poolby/${orderId}`);
  if (!key) return;
  await s().del(key);
  await s().del(`poolby/${orderId}`);
}

/** 清理孤儿占位（oid 已没有任何待支付订单） */
export async function sweepPool(): Promise<number> {
  const keys = await s().keys('pool/');
  if (!keys.length) return 0;
  let removed = 0;
  for (const k of keys) {
    const oid = await s().getText(k);
    if (!oid) continue;
    const order = await getOrder(oid);
    if (!order || order.status !== 0) {
      await s().del(k);
      await s().del(`poolby/${oid}`);
      removed++;
    }
  }
  return removed;
}

/* ================================= 订单 ================================= */

/** 列表页需要的摘要（不是订单全文） */
export interface OrderSummary {
  id: number;
  pid: number;
  order_id: string;
  out_trade_no: string;
  name: string;
  type: number;
  money: string;
  truemoney: string;
  status: number;
  create_time: number;
  pay_time: number;
  notify_attempts: number;
  /** 通道维度统计要用（列表不展示，但一直在摘要里，避免回查整单） */
  passage_id: number;
}

function toSummary(o: OrderRow): OrderSummary {
  return {
    id: o.id,
    pid: o.pid,
    order_id: o.order_id,
    out_trade_no: o.out_trade_no,
    name: o.name,
    type: o.type,
    money: o.money,
    truemoney: o.truemoney,
    status: o.status,
    create_time: o.create_time,
    pay_time: o.pay_time,
    notify_attempts: o.notify_attempts,
    passage_id: o.passage_id,
  };
}

/** 月份摘要缓存：同一实例 5 秒内不重复拉取 */
const shardCache = new Map<string, { at: number; rows: OrderSummary[] }>();
const SHARD_TTL_MS = 5_000;

async function loadShard(ym: string): Promise<OrderSummary[]> {
  const hit = shardCache.get(ym);
  if (hit && Date.now() - hit.at < SHARD_TTL_MS) return hit.rows;
  const rows = (await readJson<OrderSummary[]>(`odx/${ym}`)) ?? [];
  shardCache.set(ym, { at: Date.now(), rows });
  return rows;
}

async function listShardMonths(): Promise<string[]> {
  const keys = await s().keys('odx/');
  return keys.map((k) => k.slice(4)).sort();
}

/** 读全部月份摘要（带缓存），统计与列表共用 */
async function allSummaries(): Promise<OrderSummary[]> {
  const months = await listShardMonths();
  const out: OrderSummary[] = [];
  for (const ym of months) out.push(...(await loadShard(ym)));
  return out;
}

async function putShardRow(order: OrderRow): Promise<void> {
  const ym = ymOf(order.create_time);
  await withLock(`odx/${ym}`, async () => {
    const rows = (await readJson<OrderSummary[]>(`odx/${ym}`)) ?? [];
    const next = rows.filter((r) => r.id !== order.id);
    next.unshift(toSummary(order));
    next.sort((a, b) => b.id - a.id);
    await writeJson(`odx/${ym}`, next);
    shardCache.set(ym, { at: Date.now(), rows: next });
  });
}

async function dropShardRows(ids: number[], createTimes: number[]): Promise<void> {
  const months = new Set(createTimes.map(ymOf));
  for (const ym of months) {
    await withLock(`odx/${ym}`, async () => {
      const rows = (await readJson<OrderSummary[]>(`odx/${ym}`)) ?? [];
      const next = rows.filter((r) => !ids.includes(r.id));
      await writeJson(`odx/${ym}`, next);
      shardCache.set(ym, { at: Date.now(), rows: next });
    });
  }
}

export async function getOrder(orderId: string): Promise<OrderRow | null> {
  return readJson<OrderRow>(`o/${orderId}`);
}

export async function getOrderById(id: number): Promise<OrderRow | null> {
  const oid = await s().getText(`oi/${id}`);
  return oid ? getOrder(oid) : null;
}

export async function findByOutTradeNo(outTradeNo: string): Promise<string | null> {
  return s().getText(`ou/${outTradeNo}`);
}

/**
 * 找「这个金额、这个支付方式」当前那笔待支付订单。
 *
 * 金额池的 key 本身就是互斥的，所以先走 O(1) 的占位查询；
 * 占位不存在（比如管理员手工补的数据）再退回扫当月摘要。
 */
export async function findPendingByPrice(
  priceYuan: string,
  type: number
): Promise<OrderRow | null> {
  const fen = Math.round(Number(priceYuan) * 100);
  if (Number.isFinite(fen) && fen > 0) {
    const oid = await s().getText(`pool/${fen}-${type}`);
    if (oid) {
      const order = await getOrder(oid);
      if (order && order.status === 0 && order.truemoney === priceYuan) return order;
    }
  }
  const all = await allSummaries();
  const hit = all
    .filter((r) => r.truemoney === priceYuan && r.status === 0 && r.type === type)
    .sort((a, b) => a.id - b.id)[0];
  return hit ? getOrder(hit.order_id) : null;
}

export interface NewOrderInput {
  orderId: string;
  outTradeNo: string;
  name: string;
  type: number;
  pid: number;
  passageId: number;
  money: string;
  truemoney: string;
  payUrl: string;
  notifyUrl?: string;
  returnUrl?: string;
  sitename?: string;
  param?: string;
  ip: string;
  createTime: number;
}

/**
 * 落一笔订单。
 *
 * 商户订单号靠 `ou/` 条件写保证唯一 —— 并发下单时只有一笔能写入成功，
 * 竞争失败的那笔由调用方释放金额占位。
 */
export async function insertOrder(input: NewOrderInput): Promise<{ ok: boolean; order?: OrderRow }> {
  const uniqOk = await s().put(`ou/${input.outTradeNo}`, input.orderId, { onlyIfNew: true });
  if (!uniqOk) return { ok: false };

  // 同毫秒并发下单时递增，保证 oi/<id> 不撞（个人量级几乎不会发生）
  let id = Date.now();
  for (let i = 0; i < 50 && (await s().getText(`oi/${id}`)); i++) id++;
  const order: OrderRow = {
    id,
    order_id: input.orderId,
    out_trade_no: input.outTradeNo,
    name: input.name,
    type: input.type,
    pid: input.pid,
    passage_id: input.passageId,
    money: input.money,
    truemoney: input.truemoney,
    pay_url: input.payUrl,
    is_auto: 1,
    notify_url: input.notifyUrl ?? '',
    return_url: input.returnUrl ?? '',
    sitename: input.sitename ?? '',
    param: input.param ?? '',
    status: 0,
    create_time: input.createTime,
    pay_time: 0,
    close_time: 0,
    notify_attempts: 0,
    ip: input.ip,
  };

  await writeJson(`o/${order.order_id}`, order);
  await s().put(`oi/${id}`, order.order_id);
  await putShardRow(order);
  return { ok: true, order };
}

/**
 * 改订单字段。`expectStatus` 传了就做「状态未变才改」的乐观校验，
 * 等价于原来的 `UPDATE ... WHERE status = ?`（回调、关单、补单会并发）。
 */
export async function patchOrder(
  orderId: string,
  patch: Partial<OrderRow>,
  expectStatus?: number
): Promise<OrderRow | null> {
  const cur = await getOrder(orderId);
  if (!cur) return null;
  if (expectStatus !== undefined && cur.status !== expectStatus) return null;
  const next: OrderRow = { ...cur, ...patch };
  await writeJson(`o/${orderId}`, next);
  await putShardRow(next);
  return next;
}

export interface OrderListFilter {
  status?: number;
  type?: number;
  startTs?: number;
  endTs?: number;
  keyword?: string;
  limit: number;
  offset: number;
}

function matchOrder(r: OrderSummary, f: OrderListFilter): boolean {
  if (f.status !== undefined && r.status !== f.status) return false;
  if (f.type !== undefined && r.type !== f.type) return false;
  if (f.startTs !== undefined && r.create_time < f.startTs) return false;
  if (f.endTs !== undefined && r.create_time > f.endTs) return false;
  if (f.keyword) {
    const kw = f.keyword.toLowerCase();
    const hit =
      r.order_id.toLowerCase().includes(kw) ||
      r.out_trade_no.toLowerCase().includes(kw) ||
      (r.name ?? '').toLowerCase().includes(kw);
    if (!hit) return false;
  }
  return true;
}

export async function listOrders(
  f: OrderListFilter
): Promise<{ rows: OrderSummary[]; count: number }> {
  const all = await allSummaries();
  const hit = all.filter((r) => matchOrder(r, f)).sort((a, b) => b.id - a.id);
  return { rows: hit.slice(f.offset, f.offset + f.limit), count: hit.length };
}

export async function removeOrders(ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const docs: OrderRow[] = [];
  for (const id of ids) {
    const doc = await getOrderById(id);
    if (doc) docs.push(doc);
  }
  for (const doc of docs) {
    await s().del(`o/${doc.order_id}`);
    await s().del(`ou/${doc.out_trade_no}`);
    await s().del(`oi/${doc.id}`);
    await s().del(`poolby/${doc.order_id}`);
  }
  if (docs.length) await dropShardRows(docs.map((d) => d.id), docs.map((d) => d.create_time));
  return docs.length;
}

/** 各状态订单数（看板用） */
export async function countsByStatus(): Promise<Record<string, number>> {
  const all = await allSummaries();
  const out: Record<string, number> = {};
  for (const r of all) out[String(r.status)] = (out[String(r.status)] ?? 0) + 1;
  return out;
}

export interface Totals {
  c: number;
  s: number;
}

const fenOf = (yuan: string): number => Math.round(Number(yuan || 0) * 100);

/** 累计已收（1/2 都算钱已到账） */
export async function paidTotals(): Promise<Totals> {
  const all = await allSummaries();
  let c = 0;
  let fen = 0;
  for (const r of all) {
    if (r.status === 1 || r.status === 2) {
      c++;
      fen += fenOf(r.truemoney);
    }
  }
  return { c, s: fen / 100 };
}

/** 指定时刻之后的已收（按支付时间） */
export async function paidSince(since: number): Promise<Totals> {
  const all = await allSummaries();
  let c = 0;
  let fen = 0;
  for (const r of all) {
    if ((r.status === 1 || r.status === 2) && r.pay_time >= since) {
      c++;
      fen += fenOf(r.truemoney);
    }
  }
  return { c, s: fen / 100 };
}

/** 按天聚合（dayKey → 汇总），看板 7 天曲线用 */
export async function dailyPaid(since: number): Promise<Map<number, Totals>> {
  const all = await allSummaries();
  const map = new Map<number, Totals>();
  for (const r of all) {
    if ((r.status !== 1 && r.status !== 2) || r.pay_time < since) continue;
    const k = dayKeyOf(r.pay_time);
    const cur = map.get(k) ?? { c: 0, s: 0 };
    map.set(k, { c: cur.c + 1, s: cur.s + fenOf(r.truemoney) / 100 });
  }
  return map;
}

/* ================================ 回调任务 =============================== */

export interface NotifyTask {
  id: number;
  order_id: string;
  url: string;
  payload: string;
  attempts: number;
  next_at: number;
  done: number;
  last_error?: string;
}

export async function addNotify(
  orderId: string,
  url: string,
  payload: string,
  nextAt: number
): Promise<number> {
  const id = Date.now();
  const task: NotifyTask = {
    id,
    order_id: orderId,
    url,
    payload,
    attempts: 0,
    next_at: nextAt,
    done: 0,
  };
  await writeJson(`nt/${id}`, task);
  await s().put(`ntq/${String(nextAt).padStart(12, '0')}-${id}`, String(id));
  return id;
}

export async function getNotify(id: number): Promise<NotifyTask | null> {
  return readJson<NotifyTask>(`nt/${id}`);
}

/** 更新任务；next_at 变化时同步到期索引（索引 key 里带时间，必须删旧建新） */
export async function saveNotify(task: NotifyTask): Promise<void> {
  const prev = await getNotify(task.id);
  await writeJson(`nt/${task.id}`, task);
  if (prev && prev.next_at !== task.next_at) {
    await s().del(`ntq/${String(prev.next_at).padStart(12, '0')}-${prev.id}`);
  }
  if (task.done === 1) {
    await s().del(`ntq/${String(task.next_at).padStart(12, '0')}-${task.id}`);
  } else if (!prev || prev.next_at !== task.next_at) {
    await s().put(`ntq/${String(task.next_at).padStart(12, '0')}-${task.id}`, String(task.id));
  }
}

/** 到期任务 id（按 next_at 升序） */
export async function dueNotify(ts: number, limit: number): Promise<number[]> {
  const keys = await s().keys('ntq/');
  const out: number[] = [];
  for (const k of keys.sort()) {
    const at = Number(k.slice(4, 16));
    if (!Number.isFinite(at) || at > ts) continue;
    out.push(Number(k.slice(17)));
    if (out.length >= limit) break;
  }
  return out;
}

/* ================================= 通道 ================================= */

type PassageDoc = PassageRow;

async function readPassages(): Promise<PassageDoc[]> {
  return (await readJson<PassageDoc[]>('ps')) ?? [];
}

async function writePassages(list: PassageDoc[]): Promise<void> {
  await writeJson('ps', list);
}

function withSucc(doc: PassageDoc, all: OrderSummary[]): PassageRow {
  let c = 0;
  let fen = 0;
  for (const r of all) {
    if (r.status !== 1 && r.status !== 2) continue;
    if (r.passage_id !== doc.id) continue;
    c++;
    fen += fenOf(r.truemoney);
  }
  return { ...doc, succcount: c, succprice: (fen / 100).toFixed(2) };
}

export async function getPassage(id: number): Promise<PassageRow | null> {
  const list = await readPassages();
  const doc = list.find((p) => p.id === id);
  return doc ?? null;
}

export async function listPassages(filter: {
  type?: number;
  code?: number;
  status?: number;
  startTs?: number;
  endTs?: number;
  zfPid?: string;
  remarks?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: PassageRow[]; count: number }> {
  const list = await readPassages();
  const all = await allSummaries();
  const hit = list
    .filter((p) => {
      if (filter.type !== undefined && p.type !== filter.type) return false;
      if (filter.code !== undefined && p.code !== filter.code) return false;
      if (filter.status !== undefined && p.status !== filter.status) return false;
      if (filter.startTs !== undefined && p.create_time < filter.startTs) return false;
      if (filter.endTs !== undefined && p.create_time > filter.endTs) return false;
      if (filter.zfPid && p.zf_pid !== filter.zfPid) return false;
      if (filter.remarks && !(p.remarks ?? '').includes(filter.remarks)) return false;
      return true;
    })
    .sort((a, b) => a.id - b.id)
    .map((p) => withSucc(p, all));
  return { rows: hit.slice(filter.offset, filter.offset + filter.limit), count: hit.length };
}

export async function insertPassage(data: Record<string, unknown>): Promise<number> {
  return withLock('ps', async () => {
    const list = await readPassages();
    const id = list.reduce((m, p) => Math.max(m, p.id), 0) + 1;
    const t = now();
    const doc: PassageDoc = {
      id,
      type: Number(data['type'] ?? 1),
      code: Number(data['code'] ?? 0),
      zf_pid: String(data['zf_pid'] ?? ''),
      ewm_type: Number(data['ewm_type'] ?? 0),
      ewm: String(data['ewm'] ?? ''),
      balance: '0.00',
      succcount: 0,
      succprice: '0.00',
      is_status: 0,
      status: Number(data['status'] ?? 1),
      money_change: Number(data['money_change'] ?? 0),
      pay_qf: Number(data['pay_qf'] ?? 0),
      hang_free: Number(data['hang_free'] ?? 0),
      cookie: '',
      remarks: String(data['remarks'] ?? ''),
      create_time: Number(data['create_time'] ?? t),
      update_time: Number(data['update_time'] ?? t),
    };
    list.push(doc);
    await writePassages(list);
    return id;
  });
}

export async function updatePassage(id: number, data: Record<string, unknown>): Promise<void> {
  await withLock('ps', async () => {
    const list = await readPassages();
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return;
    list[i] = { ...list[i]!, ...(data as Partial<PassageDoc>), id, update_time: now() };
    await writePassages(list);
  });
}

export async function removePassages(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await withLock('ps', async () => {
    const list = await readPassages();
    await writePassages(list.filter((p) => !ids.includes(p.id)));
  });
}

/* ================================ 管理员 ================================ */

async function readAdmins(): Promise<AdminDoc[]> {
  return (await readJson<AdminDoc[]>('ad')) ?? [];
}

export async function listAdmins(filter: {
  role?: number;
  limit: number;
  offset: number;
}): Promise<{ rows: AdminDoc[]; count: number }> {
  const list = (await readAdmins())
    .filter((a) => filter.role === undefined || a.role === filter.role)
    .sort((a, b) => a.id - b.id);
  return { rows: list.slice(filter.offset, filter.offset + filter.limit), count: list.length };
}

export async function listAdminNames(): Promise<Array<{ id: number; username: string }>> {
  return (await readAdmins())
    .sort((a, b) => a.id - b.id)
    .map((a) => ({ id: a.id, username: a.username }));
}

export async function getAdmin(id: number): Promise<AdminDoc | null> {
  return (await readAdmins()).find((a) => a.id === id) ?? null;
}

export async function findAdminByUsername(username: string): Promise<AdminDoc | null> {
  return (await readAdmins()).find((a) => a.username === username) ?? null;
}

export async function countAdmins(): Promise<number> {
  return (await readAdmins()).length;
}

export async function insertAdmin(input: {
  username: string;
  passwordHash: string;
  role: number;
  status: number;
  headImg?: string;
}): Promise<number> {
  return withLock('ad', async () => {
    const list = await readAdmins();
    const id = list.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    const t = now();
    list.push({
      id,
      username: input.username,
      password_hash: input.passwordHash,
      role: input.role,
      head_img: input.headImg ?? '',
      status: input.status,
      created_at: t,
      update_time: t,
      login_time: 0,
    });
    await writeJson('ad', list);
    return id;
  });
}

export async function updateAdmin(
  id: number,
  patch: Partial<AdminDoc>
): Promise<void> {
  await withLock('ad', async () => {
    const list = await readAdmins();
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) return;
    list[i] = { ...list[i]!, ...patch, id };
    await writeJson('ad', list);
  });
}

export async function removeAdmins(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await withLock('ad', async () => {
    const list = await readAdmins();
    await writeJson('ad', list.filter((a) => !ids.includes(a.id)));
  });
}

/* ================================ 操作日志 =============================== */

export interface LogDoc {
  id: number;
  uid: number;
  content: string;
  ip: string;
  create_time: number;
}

const LOG_UID_LEN = 8;
const padUid = (uid: number) => String(uid).padStart(LOG_UID_LEN, '0');

export async function addLog(uid: number, content: string, ip: string): Promise<void> {
  const t = now();
  const id = Date.now();
  const doc: LogDoc = { id, uid, content, ip, create_time: t };
  const key = `lg/${padUid(uid)}/${String(t).padStart(12, '0')}-${id}`;
  await writeJson(key, doc);
}

/** key 形如 lg/<uid>/<时间>-<id>，时间在 key 里所以排序不用读内容 */
function logTimeOf(key: string): number {
  const seg = key.split('/')[2] ?? '';
  return Number(seg.slice(0, 12));
}

function logIdOf(key: string): number {
  return Number(key.split('-').pop() ?? '0');
}

export async function listLogs(filter: {
  uid?: number;
  limit: number;
  offset: number;
}): Promise<{ rows: Array<LogDoc & { username: string }>; count: number }> {
  const prefix = filter.uid !== undefined ? `lg/${padUid(filter.uid)}/` : 'lg/';
  const keys = (await s().keys(prefix)).sort((a, b) => logTimeOf(b) - logTimeOf(a));
  const page = keys.slice(filter.offset, filter.offset + filter.limit);
  const admins = await readAdmins();
  const nameOf = (uid: number) => admins.find((a) => a.id === uid)?.username ?? '系统';
  const rows: Array<LogDoc & { username: string }> = [];
  for (const k of page) {
    const doc = await readJson<LogDoc>(k);
    if (doc) rows.push({ ...doc, username: nameOf(doc.uid) });
  }
  return { rows, count: keys.length };
}

export async function removeLogs(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const keys = await s().keys('lg/');
  for (const k of keys) {
    if (ids.includes(logIdOf(k))) await s().del(k);
  }
}

export async function removeLogsBefore(days: number): Promise<number> {
  const before = now() - days * 86400;
  const keys = await s().keys('lg/');
  let n = 0;
  for (const k of keys) {
    if (logTimeOf(k) < before) {
      await s().del(k);
      n++;
    }
  }
  return n;
}

/* ================================ 上传图片 =============================== */

export async function putUpload(
  hash: string,
  bytes: Uint8Array,
  meta: { mime: string; size: number }
): Promise<void> {
  await s().put(`up/${hash}`, bytes);
  await writeJson(`upm/${hash}`, meta);
}

export async function getUpload(
  hash: string
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const bytes = await s().getBytes(`up/${hash}`);
  if (!bytes) return null;
  const meta = await readJson<{ mime: string; size: number }>(`upm/${hash}`);
  return { bytes, mime: meta?.mime ?? 'application/octet-stream' };
}

/* ============================= 未匹配到账推送 ============================= */

export async function addUnmatched(payload: unknown): Promise<void> {
  const t = now();
  await writeJson(`um/${String(t).padStart(12, '0')}-${Date.now()}`, payload);
}

export async function listUnmatched(limit: number): Promise<unknown[]> {
  const keys = (await s().keys('um/')).sort().reverse().slice(0, limit);
  const out: unknown[] = [];
  for (const k of keys) {
    const doc = await readJson<unknown>(k);
    if (doc) out.push(doc);
  }
  return out;
}

/** 测试用：清掉摘要缓存 */
export function clearCaches(): void {
  shardCache.clear();
  cfgCache = null;
}
