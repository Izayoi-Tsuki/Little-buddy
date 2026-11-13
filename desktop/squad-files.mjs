import { lstat, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { isTextFile, sanitizeFileName } from '../src/file-buddy.mjs';
import { ensureInboxFolder, saveTextInto, AGENT_TEXT_LIMIT } from './file-actions.mjs';
import { squadFolder } from './buddy-squads.mjs';

// 小队成员共用的文件夹：只能列出、读取和新建文本；不覆盖、不改名、不删除，也不能借路径读文件夹外的文件。
export const SQUAD_FILE_LIMIT = 200;
export const squadFolderPath = (root, squad) => ensureInboxFolder(root, squadFolder(squad));
async function plainFiles(folder) {
  const entries = await readdir(folder, { withFileTypes: true });
  return entries.filter(entry => entry.isFile()).map(entry => entry.name).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}
export async function listSquadFiles(root, squad) {
  const folder = await squadFolderPath(root, squad), names = await plainFiles(folder), files = [];
  for (const name of names.slice(0, SQUAD_FILE_LIMIT)) {
    try {
      const info = await lstat(join(folder, name));
      if (info.isFile()) files.push({ name, size: info.size, modified: new Date(info.mtimeMs).toISOString() });
    } catch { /* 列出期间被移走的文件直接跳过 */ }
  }
  return { folder: squadFolder(squad).join('/'), files, truncated: names.length > SQUAD_FILE_LIMIT };
}
// 只接受单个文件名；链接、目录、非文本和超过 128 KiB 的文件都不读内容。
export async function readSquadFile(root, squad, name) {
  let clean = null; try { clean = sanitizeFileName(name); } catch { clean = null; }
  if (typeof name !== 'string' || clean !== name) throw new Error('只能按小队文件夹里的文件名读取，不能带路径');
  const folder = await squadFolderPath(root, squad), path = join(folder, name);
  let info; try { info = await lstat(path); } catch { throw new Error(`小队文件夹里没有「${name}」`); }
  if (!info.isFile()) throw new Error('只能读取小队文件夹里的普通文件');
  const metadata = { name, size: info.size };
  if (!isTextFile(name)) return { ...metadata, notice: '当前仅解析 UTF-8 文本；此文件只提供基本信息，不能据此声称已读懂内容。' };
  if (info.size > AGENT_TEXT_LIMIT) return { ...metadata, notice: '文本超过 128 KiB，本次不读取内容。' };
  const handle = await open(path, 'r');
  try {
    const same = now => now.isFile() && now.dev === info.dev && now.ino === info.ino && now.size === info.size;
    if (!same(await handle.stat())) throw new Error('文件读取期间发生了变化，请稍后重试');
    const buffer = Buffer.alloc(info.size), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size || !same(await handle.stat())) throw new Error('文件读取期间发生了变化，请稍后重试');
    try { return { ...metadata, content: new TextDecoder('utf-8', { fatal: true }).decode(buffer) }; }
    catch { return { ...metadata, notice: '这个文件不是有效的 UTF-8 文本，本次不解析内容。' }; }
  } finally { await handle.close(); }
}
export async function saveSquadFile(root, squad, name, content) {
  const folder = await squadFolderPath(root, squad);
  if ((await plainFiles(folder)).length >= SQUAD_FILE_LIMIT) throw new Error(`小队文件夹里已有 ${SQUAD_FILE_LIMIT} 个文件，请先整理一下`);
  return saveTextInto(root, squadFolder(squad), name, content);
}
