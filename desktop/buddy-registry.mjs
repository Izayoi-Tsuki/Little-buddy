import { randomUUID } from 'node:crypto';
import { BUDDY_COLORS, BUDDY_LIMITS, sanitizeBuddyProfile } from '../src/file-buddy.mjs';
import { parseSquads } from './buddy-squads.mjs';

// 桌宠名册：只保存名字、角色、外观、位置和小队关系；对话内容不落盘。
export const DEFAULT_BUDDY = Object.freeze({ name: '纸间桌宠', role: '', look: Object.freeze({ color: 'green', style: 'short' }) });
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const point = value => Number.isFinite(value?.x) && Number.isFinite(value?.y) ? { x: Math.round(value.x), y: Math.round(value.y) } : null;
const sameName = (a, b) => a.toLocaleLowerCase('zh-CN') === b.toLocaleLowerCase('zh-CN');

// 损坏、重复或超量的条目逐条丢弃；一只都没有时用旧版位置生成默认桌宠。
export function parseRegistry(raw, legacyPosition = null) {
  let list = [];
  try { const data = JSON.parse(raw); if (Array.isArray(data?.buddies)) list = data.buddies; } catch { /* 首次启动或文件损坏 */ }
  const buddies = [];
  for (const entry of list) {
    if (buddies.length >= BUDDY_LIMITS.count) break;
    if (typeof entry?.id !== 'string' || !ID.test(entry.id) || buddies.some(b => b.id === entry.id)) continue;
    let profile; try { profile = sanitizeBuddyProfile(entry); } catch { continue; }
    if (buddies.some(b => sameName(b.name, profile.name))) continue;
    buddies.push({ id: entry.id, ...profile, position: point(entry.position) });
  }
  if (!buddies.length) buddies.push({ id: randomUUID(), ...structuredClone(DEFAULT_BUDDY), position: point(legacyPosition) });
  return buddies;
}
export function serializeRegistry(buddies, squads = []) {
  return JSON.stringify({ version: 2, buddies: buddies.map(({ id, name, role, look, position }) => ({ id, name, role, look, position: point(position) })),
    squads: squads.map(({ id, color, lead, members }) => ({ id, color, lead, members })) }, null, 2);
}
// 小队只引用已通过校验的桌宠；旧版名册没有小队。
export function parseRegistrySquads(raw, buddies) {
  let list = []; try { list = JSON.parse(raw)?.squads ?? []; } catch { list = []; }
  return parseSquads(list, buddies.map(b => b.id));
}
export function assertUniqueName(buddies, name, selfId = null) {
  if (buddies.some(b => b.id !== selfId && sameName(b.name, name))) throw new Error(`已经有一只叫「${name}」的桌宠了`);
}
export function createBuddyEntry(input, buddies) {
  if (buddies.length >= BUDDY_LIMITS.count) throw new Error(`最多同时养 ${BUDDY_LIMITS.count} 只桌宠`);
  const profile = sanitizeBuddyProfile(input); assertUniqueName(buddies, profile.name);
  return { id: randomUUID(), ...profile, position: null };
}
// 新建时给出不重名的默认名字和尚未使用的颜色。
export function suggestProfile(buddies) {
  let n = buddies.length + 1; while (buddies.some(b => sameName(b.name, `桌宠${n}`))) n++;
  const color = Object.keys(BUDDY_COLORS).find(key => !buddies.some(b => b.look.color === key)) ?? 'green';
  return { name: `桌宠${n}`, role: '', look: { color, style: 'short' } };
}
// 从工作区右下角开始，按列向左、按行向上找第一个不与已有桌宠重叠的格子。
export function spawnPosition(occupied, area, size) {
  const stepX = size.width + 12, stepY = size.height + 8, columns = Math.max(1, Math.floor((area.width - 16) / stepX));
  const right = area.x + area.width - size.width - 16, bottom = area.y + area.height - size.height - 8;
  for (let i = 0; i < columns * Math.max(1, Math.floor(area.height / stepY)); i++) {
    const candidate = { x: right - stepX * (i % columns), y: bottom - stepY * Math.floor(i / columns) };
    if (candidate.x < area.x || candidate.y < area.y) break;
    if (!occupied.some(p => p && Math.abs(p.x - candidate.x) < size.width && Math.abs(p.y - candidate.y) < size.height)) return candidate;
  }
  return { x: right, y: bottom };
}
// 组队后把拖过来的桌宠放到对方身边：依次试左、右、上、下，都被占用时退回工作区内的空格。
export function besidePosition(target, occupied, area, size, gap = 6) {
  const fits = p => p.x >= area.x && p.y >= area.y && p.x + size.width <= area.x + area.width && p.y + size.height <= area.y + area.height;
  const free = p => !occupied.some(q => q && Math.abs(q.x - p.x) < size.width && Math.abs(q.y - p.y) < size.height);
  const sides = [{ x: target.x - size.width - gap, y: target.y }, { x: target.x + size.width + gap, y: target.y },
    { x: target.x, y: target.y - size.height - gap }, { x: target.x, y: target.y + size.height + gap }];
  const fallback = spawnPosition(occupied, area, size);
  return sides.find(p => fits(p) && free(p)) ?? { x: Math.max(area.x, fallback.x), y: Math.max(area.y, fallback.y) };
}
