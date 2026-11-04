/**
 * 系统域数据访问：管理员 + 站点配置。
 *
 * 配置是全站读的 k/v（站点名、密钥、开关），EdgeOne 版整份存成一份 JSON 文档
 * （`cfg`），读走进程内 3 秒缓存，写走租约锁 —— 配置改动很少，这样最省 IO。
 * 管理员是小表，整份数组存 `ad`。
 */
import { now } from '../../lib/util';
import * as blob from '../../lib/blob-db';

/* ============================ 管理员 ============================ */

export interface AdminRow {
  id: number;
  username: string;
  role: number;
  head_img: string;
  status: number;
  created_at: number;
  login_time: number;
}

function toAdminRow(a: blob.AdminDoc): AdminRow {
  return {
    id: a.id,
    username: a.username,
    role: a.role,
    head_img: a.head_img,
    status: a.status,
    created_at: a.created_at,
    login_time: a.login_time,
  };
}

export async function listAdmins(filter: {
  role?: number;
  limit: number;
  offset: number;
}): Promise<{ rows: AdminRow[]; count: number }> {
  const r = await blob.listAdmins(filter);
  return { rows: r.rows.map(toAdminRow), count: r.count };
}

/** 下拉用：id + username，按 id 升序 */
export async function listAdminNames(): Promise<Array<{ id: number; username: string }>> {
  return blob.listAdminNames();
}

export async function findAdmin(id: number): Promise<Record<string, unknown> | null> {
  const a = await blob.getAdmin(id);
  if (!a) return null;
  return { id: a.id, username: a.username, role: a.role, head_img: a.head_img, status: a.status };
}

/** 登录校验用：带 password_hash */
export async function findAdminForLogin(
  username: string
): Promise<{ id: number; username: string; password_hash: string; status: number } | null> {
  const a = await blob.findAdminByUsername(username);
  if (!a) return null;
  return { id: a.id, username: a.username, password_hash: a.password_hash, status: a.status };
}

/** 用户名是否被他人占用 */
export async function usernameTaken(username: string, exceptId: number): Promise<boolean> {
  const a = await blob.findAdminByUsername(username);
  return !!a && a.id !== exceptId;
}

/** 是否还没有任何管理员（决定 /setup 是否会接管） */
export async function countAdmins(): Promise<number> {
  return blob.countAdmins();
}

export interface AdminInput {
  username: string;
  role: number;
  status: number;
  head_img: string;
}

export async function insertAdmin(data: AdminInput, passwordHash: string): Promise<number> {
  return blob.insertAdmin({
    username: data.username,
    passwordHash,
    role: data.role,
    status: data.status,
    headImg: data.head_img,
  });
}

/** passwordHash 传 undefined 表示不改密码 */
export async function updateAdmin(
  id: number,
  data: AdminInput,
  passwordHash?: string
): Promise<void> {
  const patch: Partial<blob.AdminDoc> = {
    username: data.username,
    role: data.role,
    status: data.status,
    head_img: data.head_img,
    update_time: now(),
  };
  if (passwordHash) patch.password_hash = passwordHash;
  await blob.updateAdmin(id, patch);
}

export async function updateLoginTime(id: number): Promise<void> {
  await blob.updateAdmin(id, { login_time: now() });
}

export async function updateProfile(id: number, data: { head_img: string }): Promise<void> {
  await blob.updateAdmin(id, { head_img: data.head_img, update_time: now() });
}

export async function updatePassword(id: number, passwordHash: string): Promise<void> {
  await blob.updateAdmin(id, { password_hash: passwordHash, update_time: now() });
}

export async function profileOf(id: number): Promise<Record<string, unknown> | null> {
  const a = await blob.getAdmin(id);
  if (!a) return null;
  return { id: a.id, username: a.username, head_img: a.head_img, status: a.status };
}

export async function usernameOf(id: number): Promise<string> {
  return (await blob.getAdmin(id))?.username ?? '';
}

export async function headImgOf(username: string): Promise<string> {
  return (await blob.findAdminByUsername(username))?.head_img ?? '';
}

export async function removeAdmins(idList: number[]): Promise<void> {
  await blob.removeAdmins(idList);
}

export async function setAdminStatus(id: number, status: number): Promise<void> {
  await blob.updateAdmin(id, { status });
}

/* ============================ 站点配置 ============================ */

export async function allConfig(): Promise<Record<string, string>> {
  return blob.allConfig();
}

/** 批量写入（一次文档读改写，避免 N 次往返） */
export async function saveConfigEntries(entries: Array<[string, string]>): Promise<void> {
  await blob.saveConfig(entries);
}
