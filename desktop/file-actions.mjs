import { lstat, mkdir, copyFile, readFile, open, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, basename } from 'node:path';
import { classifyFile, isTextFile, splitName, candidateName, formatSize, sanitizeFileName } from '../src/file-buddy.mjs';

// 文件桌宠的本地动作：只读取原文件，只在收纳箱里以独占方式新建副本；不删除、不覆盖、不移动任何文件。
export const COPY_LIMIT = 1024 ** 3;
const LINE_COUNT_LIMIT = 2 * 1024 ** 2;
export const AGENT_TEXT_LIMIT = 128 * 1024;
const GENERATED_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv', '.json']);
const friendly = error => {
  const reason = { ENOENT: '原文件已经不在原来的位置', EACCES: '没有权限读取或写入', EPERM: '没有权限读取或写入',
    EBUSY: '文件正被其他程序占用', ENOSPC: '磁盘空间不足' }[error?.code];
  return reason ? new Error(reason) : error;
};
export async function describeFile(path) {
  if (typeof path !== 'string' || !path || path.length > 1024 || !isAbsolute(path)) throw new Error('没有拿到文件位置，请从资源管理器或桌面拖入');
  let info;
  try { info = await lstat(path); } catch (error) { throw friendly(error); }
  if (info.isDirectory()) throw new Error('暂不支持文件夹，请一次放一个文件');
  if (!info.isFile()) throw new Error('只支持普通文件');
  const name = basename(path);
  return { path, name, ext: splitName(name).ext.toLowerCase(), category: classifyFile(name),
    size: info.size, modified: info.mtimeMs, created: info.birthtimeMs, identity: `${info.dev}:${info.ino}` };
}
// 执行前再次核对大小和修改时间，等待确认期间被替换或改动的文件需要重新放入。
async function verifyUnchanged(file) {
  const now = await describeFile(file.path);
  if (now.size !== file.size || now.modified !== file.modified || now.identity !== file.identity) throw new Error('文件在等待期间发生了变化，请重新放入');
  return now;
}
const time = ms => Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '未知';
export async function inspectFile(file) {
  const current = await verifyUnchanged(file);
  const rows = [['名称', current.name], ['类型', `${current.category}${current.ext ? `（${current.ext}）` : ''}`],
    ['大小', formatSize(current.size)], ['修改时间', time(current.modified)], ['创建时间', time(current.created)]];
  if (isTextFile(current.name) && current.size <= LINE_COUNT_LIMIT) {
    try {
      const text = await readFile(current.path, 'utf8');
      rows.push(['文本行数', String(text ? text.split(/\r\n|\r|\n/).length : 0)]);
    } catch (error) { throw friendly(error); }
  }
  return { kind: 'info', rows };
}
// 拒绝收纳箱或子目录被换成符号链接／junction，避免副本落到用户未确认的目录。
export async function ensureInboxFolder(root, segments) {
  await mkdir(root, { recursive: true });
  const check = async path => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('收纳箱目录不是普通文件夹，请检查是否被改成链接');
  };
  await check(root); let folder = root;
  for (const segment of segments) {
    folder = join(folder, segment);
    try { await mkdir(folder); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await check(folder);
  }
  return folder;
}
// agent 只可读取本次拖入的附件。打开后核对文件句柄身份，并限制一次读取量。
export async function readAttachment(file) {
  const current = await verifyUnchanged(file);
  const metadata = { name: current.name, category: current.category, size: current.size };
  if (!isTextFile(current.name)) return { ...metadata, notice: '当前仅解析 UTF-8 文本；此文件只提供基本信息，不能据此声称已读懂内容。' };
  if (current.size > AGENT_TEXT_LIMIT) return { ...metadata, notice: '文本超过 128 KiB，本次不读取内容。' };
  const handle = await open(current.path, 'r');
  try {
    const before = await handle.stat();
    const matches = info => info.isFile() && info.size === current.size && info.mtimeMs === current.modified && `${info.dev}:${info.ino}` === current.identity;
    if (!matches(before)) throw new Error('文件在等待期间发生了变化，请重新放入');
    const buffer = Buffer.alloc(current.size), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== current.size || !matches(await handle.stat())) throw new Error('文件读取期间发生了变化，请重新放入');
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { return { ...metadata, notice: '附件不是有效的 UTF-8 文本，本次不解析内容。' }; }
    return { ...metadata, content };
  } finally { await handle.close(); }
}
export function generatedTextPlan(name, content) {
  if (typeof name !== 'string' || typeof content !== 'string') throw new Error('需要文本内容和单个输出文件名');
  const safeName = sanitizeFileName(name);
  if (!GENERATED_EXTENSIONS.has(splitName(safeName).ext.toLowerCase())) throw new Error('只允许生成 txt、md、csv、tsv 或 json 文本文件');
  if (Buffer.byteLength(content, 'utf8') > AGENT_TEXT_LIMIT) throw new Error('生成文本不能超过 128 KiB');
  return { folder: ['生成'], name: safeName };
}
export async function saveTextIntoInbox(name, content, root) { return saveTextInto(root, generatedTextPlan(name, content).folder, name, content); }
// 在收纳箱的指定子文件夹里独占新建文本；同名时加序号，从不覆盖。
export async function saveTextInto(root, segments, name, content) {
  const plan = generatedTextPlan(name, content), folder = await ensureInboxFolder(root, segments);
  for (let attempt = 1; attempt <= 99; attempt++) {
    const output = join(folder, candidateName(plan.name, attempt));
    try {
      await writeFile(output, content, { encoding: 'utf8', flag: 'wx' });
      return { kind: 'saved', output, name: basename(output), renamed: attempt > 1 };
    } catch (error) { if (error.code !== 'EEXIST') throw friendly(error); }
  }
  throw new Error('收纳箱里同名文件太多，请先整理一下');
}
export async function copyIntoInbox(file, plan, root) {
  const current = await verifyUnchanged(file);
  if (current.size > COPY_LIMIT) throw new Error(`第一版只复制 ${formatSize(COPY_LIMIT)} 以内的文件`);
  const segmentSafe = value => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f<>:"/\\|?*]/.test(value) && !['.', '..'].includes(value) && !/[. ]$/.test(value);
  if (!plan || !Array.isArray(plan.folder) || !plan.folder.every(segmentSafe) || !segmentSafe(plan.name)) throw new Error('输出位置不在收纳箱内');
  const inside = relative(root, join(root, ...plan.folder));
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('输出位置不在收纳箱内');
  try {
    const folder = await ensureInboxFolder(root, plan.folder);
    for (let attempt = 1; attempt <= 99; attempt++) {
      const output = join(folder, candidateName(plan.name, attempt));
      try {
        await copyFile(current.path, output, constants.COPYFILE_EXCL);
        return { kind: 'saved', output, name: basename(output), renamed: attempt > 1 };
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  } catch (error) { throw friendly(error); }
  throw new Error('收纳箱里同名副本太多，请先整理一下');
}
