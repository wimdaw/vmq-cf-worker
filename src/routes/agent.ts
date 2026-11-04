/**
 * 桌面监控端（Windows / macOS / Linux）的统一接入点。
 *
 * 三个平台推上来的都是同一份 `protocol.Report`（见 agent/internal/protocol），
 * 服务端按 agent_id **覆盖式**保存最新快照，所以「统一接入」在传输层就完成了：
 * 加一台机器只需要多推一份，不需要改服务端。
 *
 * 两条路由：
 *   POST /api/agent/report   端侧推快照，凭 X-Agent-Token 鉴权
 *   GET  /api/agent/state    后台读全部机器的最新状态，凭后台会话鉴权
 *
 * 令牌取值顺序：config.agent_token → 通讯密钥（app_key）。
 * 默认复用通讯密钥是刻意的：通讯密钥本来就是这套系统的总密钥，
 * 而 agent 上报只写「监控快照」这一个命名空间，泄漏面不比通讯密钥本身更大。
 * 想隔离的部署在后台配置 agent_token 即可，无需改代码。
 */
import type { Env } from '../lib/db';
import { appSecret, getConfig } from '../lib/db';
import { json, clientIp, now } from '../lib/util';
import { readSession } from '../lib/auth';
import { getAgentReport, listAgentReports, putAgentReport } from '../lib/blob-db';

/** 契约主版本：与 agent 的 protocol.Version 对齐，只认主版本号 */
const REPORT_VERSION = '1';

/** 单份快照上限。正常在 4~8 KB，给到 256 KB 是为了容纳较长的进程/磁盘列表 */
const MAX_BODY = 256 * 1024;

/** 主机离线判定：超过 3 个采集间隔没上报就算失联 */
const STALE_FACTOR = 3;

type Snapshot = Record<string, unknown> & {
  agent_id?: string;
  ts?: number;
  interval?: number;
};

async function agentToken(env: Env): Promise<string> {
  const t = (await getConfig(env, 'agent_token', '')).trim();
  if (t) return t;
  return appSecret(env);
}

/** 定长比较，避免按字符逐位短路带来的时序差 */
function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length || x.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] as number) ^ (y[i] as number);
  return diff === 0;
}

/** agent_id 会进 Blob 的 key，必须收敛字符集，避免出现 `/` 把命名空间打散 */
function sanitizeId(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 64);
}

export async function handleAgentReport(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return json({ code: -1, msg: '只接受 POST' }, 405);

  const expect = await agentToken(env);
  if (!expect) return json({ code: -1, msg: '服务端未配置通讯密钥' });

  const got = req.headers.get('x-agent-token') ?? '';
  if (!safeEqual(got, expect)) return json({ code: -1, msg: '令牌校验不通过' }, 401);

  const raw = await req.text();
  if (raw.length > MAX_BODY) return json({ code: -1, msg: '快照过大' }, 413);

  let snap: Snapshot;
  try {
    snap = JSON.parse(raw) as Snapshot;
  } catch {
    return json({ code: -1, msg: 'JSON 解析失败' });
  }

  if (String(snap.v ?? '') !== REPORT_VERSION) {
    return json({ code: -1, msg: `协议版本不支持：${String(snap.v ?? '(缺失)')}，服务端要求 ${REPORT_VERSION}` });
  }
  const id = sanitizeId(String(snap.agent_id ?? ''));
  if (!id) return json({ code: -1, msg: '缺少 agent_id' });

  const ts = Number(snap.ts ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return json({ code: -1, msg: 'ts 不合法' });

  await putAgentReport(id, {
    ...snap,
    agent_id: id,
    received_at: now(),
    remote_ip: clientIp(req),
  });

  return json({ code: 0, msg: 'ok', agent_id: id });
}

export async function handleAgentState(req: Request, env: Env): Promise<Response> {
  const session = await readSession(req, env);
  if (!session) return json({ code: 0, msg: '未登录' }, 401);

  const rows = (await listAgentReports()) as Snapshot[];
  const t = now();
  const data = rows
    .map((r) => {
      const ts = Number(r.ts ?? 0);
      const interval = Number(r.interval ?? 30) || 30;
      const ageSec = ts > 0 ? Math.max(0, t - ts) : -1;
      return {
        ...r,
        age_sec: ageSec,
        stale: ageSec < 0 || ageSec > interval * STALE_FACTOR,
      };
    })
    .sort((a, b) => String(a.agent_id ?? '').localeCompare(String(b.agent_id ?? '')));

  return json({ code: 0, msg: '', count: data.length, data });
}

/** 单机详情：后台点进某一台时用，顺带返回该机器的原始快照 */
export async function handleAgentOne(req: Request, env: Env, agentId: string): Promise<Response> {
  const session = await readSession(req, env);
  if (!session) return json({ code: 0, msg: '未登录' }, 401);

  const doc = (await getAgentReport(sanitizeId(agentId))) as Snapshot | null;
  if (!doc) return json({ code: 0, msg: '没有这台机器的上报记录' });

  const ageSec = Math.max(0, now() - Number(doc.ts ?? 0));
  return json({ code: 1, msg: '', data: { ...doc, age_sec: ageSec } });
}
