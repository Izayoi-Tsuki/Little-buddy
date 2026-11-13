import { SQUAD_COLORS } from '../src/file-buddy.mjs';

// 小队：成员互为同伴；设了带队者时，带队者负责其余成员（只有一层）。每只桌宠最多属于一支小队。
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLORS = Object.keys(SQUAD_COLORS);
const freeColor = (squads, preferred) => COLORS.includes(preferred) && !squads.some(s => s.color === preferred) ? preferred
  : COLORS.find(color => !squads.some(s => s.color === color)) ?? COLORS[0];
export const squadOf = (squads, id) => squads.find(s => s.members.includes(id)) ?? null;
export const nextSquadColor = squads => freeColor(squads);

// 名册里的小队逐条校验：成员必须是现存桌宠、不跨队、至少两只；带队者必须是成员；颜色不重复。
export function parseSquads(list, buddyIds) {
  const known = new Set(buddyIds), used = new Set(), squads = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry?.id !== 'string' || !ID.test(entry.id) || squads.some(s => s.id === entry.id) || !Array.isArray(entry.members)) continue;
    const members = [...new Set(entry.members)].filter(id => typeof id === 'string' && known.has(id) && !used.has(id));
    if (members.length < 2) continue;
    members.forEach(id => used.add(id));
    squads.push({ id: entry.id, color: freeColor(squads, entry.color), lead: members.includes(entry.lead) ? entry.lead : null, members });
  }
  return squads;
}

// 把 dragged 拖到 target 身上时可选的关系；不能组队时给出原因、不给选项。
export function linkOptions(squads, dragged, target, nameOf) {
  if (dragged === target) throw new Error('不能和自己组队');
  const a = `「${nameOf(dragged)}」`, b = `「${nameOf(target)}」`, sa = squadOf(squads, dragged), sb = squadOf(squads, target);
  if (sa && sb && sa !== sb) return { title: '暂时不能组队', note: `${a}和${b}各自在不同的小队里。先在右键菜单里让其中一只离开小队，再拖过来。`, options: [] };
  if (!sa && !sb) return { title: `${a}和${b}组队`, note: '', options: [
    { id: 'peer', label: '同伴', hint: '平级合作，谁也不带谁' },
    { id: 'lead-dragged', label: `${a}带${b}`, hint: `由${a}分派任务` },
    { id: 'lead-target', label: `${b}带${a}`, hint: `由${b}分派任务` },
  ] };
  if (sa === sb) {
    const lead = sa.lead, options = [];
    if (lead) options.push({ id: 'peer', label: '全队改为同伴', hint: '取消带队，成员平级' });
    if (lead !== dragged) options.push({ id: 'lead-dragged', label: `改由${a}带队`, hint: '其余成员都由它分派任务' });
    if (lead !== target) options.push({ id: 'lead-target', label: `改由${b}带队`, hint: '其余成员都由它分派任务' });
    options.push({ id: 'leave', label: `${a}离开小队`, hint: sa.members.length <= 2 ? '只剩一只时小队解散' : '其余成员保持不变' });
    return { title: '调整小队关系', note: '', options };
  }
  const host = sa ?? sb, newcomer = sa ? target : dragged, n = `「${nameOf(newcomer)}」`;
  if (host.lead) return { title: `${n}加入小队`, note: '', options: [{ id: 'join', label: `加入，由「${nameOf(host.lead)}」带`, hint: '小队的带队关系不变' }] };
  return { title: `${n}加入小队`, note: '', options: [
    { id: 'peer', label: '作为同伴加入', hint: '和现有成员平级' },
    { id: newcomer === dragged ? 'lead-dragged' : 'lead-target', label: `加入并由${n}带队`, hint: '其余成员都由它分派任务' },
  ] };
}

export function leaveSquad(squads, id) {
  return squads.flatMap(s => {
    if (!s.members.includes(id)) return [s];
    const members = s.members.filter(member => member !== id);
    return members.length < 2 ? [] : [{ ...s, members, lead: s.lead === id ? null : s.lead }];
  });
}

// 只接受当前局面下真实可选的关系，返回新的小队列表；原列表不变。
export function applyLink(squads, dragged, target, optionId, { nameOf, newId }) {
  const { options } = linkOptions(squads, dragged, target, nameOf);
  if (!options.some(option => option.id === optionId)) throw new Error('这个关系已经不可选，请重新拖动');
  if (optionId === 'leave') return leaveSquad(squads, dragged);
  const sa = squadOf(squads, dragged), sb = squadOf(squads, target), host = sa ?? sb;
  const squad = host ? { ...host, members: [...host.members] } : { id: newId(), color: freeColor(squads), lead: null, members: [target, dragged] };
  if (host && !(sa && sb)) squad.members.push(sa ? target : dragged);
  if (optionId === 'peer') squad.lead = null;
  else if (optionId === 'lead-dragged') squad.lead = dragged;
  else if (optionId === 'lead-target') squad.lead = target;
  return host ? squads.map(s => s === host ? squad : s) : [...squads, squad];
}

// 给某只桌宠看的小队概况：颜色、自己是否带队、一行可读的成员说明，以及可以斜杠召唤的同队名字。
export function squadView(squads, id, nameOf) {
  const s = squadOf(squads, id); if (!s) return null;
  const others = s.members.filter(member => member !== s.lead).map(nameOf);
  const summary = s.lead ? `「${nameOf(s.lead)}」带 ${others.join('、')}` : `同伴 ${s.members.map(nameOf).join('、')}`;
  const mates = s.members.filter(member => member !== id).map(nameOf);
  return { id: s.id, color: s.color, lead: s.lead === id, led: !!s.lead, size: s.members.length, summary, mates };
}

// 小队文件夹在收纳箱「小队」下，按颜色和小队 ID 前缀命名；小队解散后文件夹保留。
export const squadFolder = squad => ['小队', `${SQUAD_COLORS[squad.color]?.label ?? ''}小队-${squad.id.slice(0, 8)}`];
// 随每条消息发给模型的小队概况：只有名字和相对文件夹名，不含绝对路径。
export function squadContext(squads, id, nameOf) {
  const s = squadOf(squads, id); if (!s) return null;
  return { role: s.lead === id ? 'lead' : s.lead ? 'member' : 'peer', lead: s.lead ? nameOf(s.lead) : null,
    members: s.members.filter(member => member !== id).map(nameOf), folder: squadFolder(s).join('/') };
}

// 派活：只有带队者能派，只派给同队成员；正在执行派来任务的不能再派，所以不会循环，也只有一层。
export const TEAM_LIMIT = 4;
export function dispatchTarget(squads, from, memberName, { nameOf, busy, tasked, working, limit = TEAM_LIMIT }) {
  const s = squadOf(squads, from);
  if (!s) throw new Error('你现在不在小队里，不能派活');
  if (s.lead !== from) throw new Error('只有带队的桌宠可以派活');
  if (tasked(from)) throw new Error('正在执行派来的任务时不能再派活');
  const others = s.members.filter(id => id !== from), target = others.find(id => nameOf(id) === memberName);
  if (!target) throw new Error(`小队里没有叫「${String(memberName ?? '').slice(0, 20)}」的成员；可以派给：${others.map(id => `「${nameOf(id)}」`).join('、')}`);
  if (busy(target) || tasked(target)) throw new Error(`「${nameOf(target)}」正忙，等它完成后再派`);
  if (working() + 1 > limit) throw new Error(`同时工作的桌宠最多 ${limit} 只，请等其他桌宠完成后再派`);
  return target;
}
