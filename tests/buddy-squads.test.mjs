import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BUDDY_LAYOUT } from '../src/file-buddy.mjs';
import { squadOf, nextSquadColor, parseSquads, linkOptions, leaveSquad, applyLink, squadView } from '../desktop/buddy-squads.mjs';
import { parseRegistry, parseRegistrySquads, serializeRegistry, besidePosition } from '../desktop/buddy-registry.mjs';

const [A, B, C, D, E] = Array.from({ length: 5 }, () => randomUUID());
const names = { [A]: '甲', [B]: '乙', [C]: '丙', [D]: '丁', [E]: '戊' };
const nameOf = id => names[id];
const ids = (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; })();
const link = (squads, dragged, target, option) => applyLink(squads, dragged, target, option, { nameOf, newId: ids });
const optionIds = (squads, dragged, target) => linkOptions(squads, dragged, target, nameOf).options.map(o => o.id);

test('名册里的小队逐条校验：未知成员、跨队、不足两只、坏 id 丢弃，带队者必须是成员，颜色不重复', () => {
  const s1 = ids(), s2 = ids(), s3 = ids();
  const list = parseSquads([
    { id: s1, color: 'gold', lead: A, members: [A, B, B, 'ghost'] },
    { id: s2, color: 'gold', lead: C, members: [B, D] },
    { id: s3, color: 'nope', lead: 'ghost', members: [C, D, E] },
    { id: 'bad', color: 'steel', lead: null, members: [E, C] },
    { id: s1, color: 'rose', lead: null, members: [E, C] },
    null, { id: ids(), members: 'x' },
  ], [A, B, C, D, E]);
  assert.deepEqual(list, [
    { id: s1, color: 'gold', lead: A, members: [A, B] },
    { id: s3, color: 'steel', lead: null, members: [C, D, E] },
  ]);
  assert.deepEqual(parseSquads('x', [A]), []);
  assert.equal(nextSquadColor(list), 'copper');
  assert.equal(squadOf(list, E).id, s3); assert.equal(squadOf(list, 'none'), null);
});

test('两只都没入队：同伴或其中一只带队；新小队取未用的颜色', () => {
  assert.throws(() => linkOptions([], A, A, nameOf), /自己/);
  const first = linkOptions([], A, B, nameOf);
  assert.equal(first.title, '「甲」和「乙」组队');
  assert.deepEqual(first.options.map(o => [o.id, o.label]), [['peer', '同伴'], ['lead-dragged', '「甲」带「乙」'], ['lead-target', '「乙」带「甲」']]);
  const peer = link([], A, B, 'peer');
  assert.deepEqual(peer.map(s => [s.color, s.lead, s.members]), [['steel', null, [B, A]]]);
  const led = link(peer, C, D, 'lead-target');
  assert.deepEqual(led[1], { id: led[1].id, color: 'copper', lead: D, members: [D, C] });
  assert.equal(peer.length, 1, '原列表不变');
});

test('一只已在小队：有带队者时只能加入；没有时可同伴加入或由新成员带队；两个方向都可以拖', () => {
  const peer = link([], A, B, 'peer');
  assert.deepEqual(optionIds(peer, C, A), ['peer', 'lead-dragged']);
  assert.deepEqual(optionIds(peer, A, C), ['peer', 'lead-target']);
  assert.equal(linkOptions(peer, C, A, nameOf).options[1].label, '加入并由「丙」带队');
  const led = link(peer, A, C, 'lead-target');
  assert.deepEqual([led[0].lead, led[0].members], [C, [B, A, C]]);
  const join = linkOptions(led, D, B, nameOf);
  assert.deepEqual(join.options.map(o => [o.id, o.label]), [['join', '加入，由「丙」带']]);
  const joined = link(led, D, B, 'join');
  assert.deepEqual([joined[0].lead, joined[0].members], [C, [B, A, C, D]]);
  assert.throws(() => link(led, D, B, 'peer'), /不可选/);
});

test('同一小队：可改为同伴、换带队者或离开；不同小队不给选项', () => {
  let squads = link(link([], A, B, 'lead-dragged'), C, A, 'join');
  assert.deepEqual(optionIds(squads, B, A), ['peer', 'lead-dragged', 'leave']);
  assert.deepEqual(optionIds(squads, A, B), ['peer', 'lead-target', 'leave']);
  squads = link(squads, B, C, 'lead-dragged'); assert.equal(squads[0].lead, B);
  squads = link(squads, A, C, 'peer'); assert.equal(squads[0].lead, null);
  assert.deepEqual(optionIds(squads, A, C), ['lead-dragged', 'lead-target', 'leave']);
  assert.equal(linkOptions(squads, A, C, nameOf).options.at(-1).hint, '其余成员保持不变');
  squads = link(squads, A, C, 'leave'); assert.deepEqual(squads[0].members, [B, C]);
  assert.equal(linkOptions(squads, B, C, nameOf).options.at(-1).hint, '只剩一只时小队解散');
  const two = link(squads, D, E, 'peer');
  const blocked = linkOptions(two, D, B, nameOf);
  assert.deepEqual(blocked.options, []); assert.match(blocked.note, /离开小队/);
  assert.throws(() => link(two, D, B, 'peer'), /不可选/);
});

test('离队：带队者离开后其余成员变同伴，只剩一只时小队解散；概况说明可读', () => {
  const squads = link(link([], A, B, 'lead-dragged'), C, B, 'join');
  assert.deepEqual(squadView(squads, B, nameOf), { id: squads[0].id, color: 'steel', lead: false, led: true, size: 3, summary: '「甲」带 乙、丙', mates: ['甲', '丙'] });
  assert.equal(squadView(squads, A, nameOf).lead, true); assert.equal(squadView(squads, D, nameOf), null);
  const left = leaveSquad(squads, A);
  assert.deepEqual([left[0].lead, left[0].members], [null, [B, C]]);
  assert.equal(squadView(left, B, nameOf).summary, '同伴 乙、丙');
  assert.deepEqual(leaveSquad(left, C), []);
  assert.deepEqual(leaveSquad(left, D), left, '不在队里的不影响');
});

test('名册 v2 往返保存小队，旧版名册没有小队；删掉的桌宠不会留在小队里', () => {
  const buddies = [A, B, C].map((id, i) => ({ id, name: names[id], role: '', look: { color: 'green', style: 'short' }, position: { x: i * 100, y: 0 } }));
  const squads = link([], A, B, 'lead-target');
  const raw = serializeRegistry(buddies, squads), saved = JSON.parse(raw);
  assert.equal(saved.version, 2); assert.deepEqual(Object.keys(saved.squads[0]), ['id', 'color', 'lead', 'members']);
  const entries = parseRegistry(raw);
  assert.deepEqual(parseRegistrySquads(raw, entries), squads);
  assert.deepEqual(parseRegistrySquads(serializeRegistry(buddies.slice(1), squads), buddies.slice(1)), []);
  assert.deepEqual(parseRegistrySquads(JSON.stringify({ version: 1, buddies }), buddies), []);
  assert.deepEqual(parseRegistrySquads('{', buddies), []);
});

test('组队后放到对方身边：先左后右再上下，不重叠、不越出工作区', () => {
  const size = BUDDY_LAYOUT, area = { x: 0, y: 0, width: 600, height: 400 }, gap = 6;
  const target = { x: 300, y: 200 };
  assert.deepEqual(besidePosition(target, [target], area, size), { x: 300 - size.width - gap, y: 200 });
  assert.deepEqual(besidePosition(target, [target, { x: 214, y: 200 }], area, size), { x: 300 + size.width + gap, y: 200 });
  const edge = { x: 0, y: 0 };
  assert.deepEqual(besidePosition(edge, [edge], area, size), { x: size.width + gap, y: 0 });
  const tiny = { x: 0, y: 0, width: size.width, height: size.height };
  const p = besidePosition(edge, [edge], tiny, size);
  assert.ok(p.x >= 0 && p.y >= 0 && p.x + size.width <= tiny.width && p.y + size.height <= tiny.height);
});
