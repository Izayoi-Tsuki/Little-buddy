import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BUDDY_LIMITS, BUDDY_LAYOUT, sanitizeBuddyProfile, buddyCharacter } from '../src/file-buddy.mjs';
import { DEFAULT_BUDDY, parseRegistry, serializeRegistry, assertUniqueName, createBuddyEntry, suggestProfile, spawnPosition } from '../desktop/buddy-registry.mjs';
import { agentPrompt, BuddyAgent } from '../desktop/buddy-agent.mjs';
import { createDeepSeekSession } from '../desktop/buddy-deepseek.mjs';

const NL = '\x0a';
const entry = (name, extra = {}) => ({ id: randomUUID(), name, role: '', look: { color: 'green', style: 'short' }, position: null, ...extra });

test('桌宠设定：名字单行、角色有上限、外观只接受已知选项', () => {
  const p = sanitizeBuddyProfile({ name: '  资料\t员  ', role: `a\r${NL}\r${NL}\r${NL}\r${NL}b\u202ec`, look: { color: 'blue', style: 'nope' } });
  assert.deepEqual(p, { name: '资料 员', role: `a${NL}${NL}bc`, look: { color: 'blue', style: 'short' } });
  assert.throws(() => sanitizeBuddyProfile({ name: ' \u200b ' }), /起个名字/);
  assert.throws(() => sanitizeBuddyProfile({ name: '一'.repeat(BUDDY_LIMITS.name + 1) }), /不能超过/);
  assert.equal(sanitizeBuddyProfile({ name: '😀'.repeat(BUDDY_LIMITS.name) }).name.length, BUDDY_LIMITS.name * 2);
  assert.throws(() => sanitizeBuddyProfile({ name: 'a', role: 'x'.repeat(BUDDY_LIMITS.role + 1) }), /角色设定/);
  assert.deepEqual(sanitizeBuddyProfile({ name: 'a', look: { color: '__proto__', style: 'toString' } }).look, { color: 'green', style: 'short' });
  assert.deepEqual(buddyCharacter({ color: 'orange', style: 'mascot' }), { provider: 'Anthropic', form: 'mascot', gender: 'neutral' });
  assert.deepEqual(buddyCharacter(null), { provider: 'OpenAI', form: 'human', gender: 'neutral' });
});

test('名册：损坏、重复 id、重名、超量条目逐条丢弃，空名册沿用旧位置生成默认桌宠', () => {
  for (const raw of ['', '{', 'null', '{"buddies":{}}', JSON.stringify({ buddies: [{ id: 'x', name: 'a' }] })]) {
    const [only, ...rest] = parseRegistry(raw, { x: 10.4, y: 20.6 });
    assert.equal(rest.length, 0); assert.equal(only.name, DEFAULT_BUDDY.name); assert.deepEqual(only.position, { x: 10, y: 21 });
  }
  assert.equal(parseRegistry('', null)[0].position, null);
  const a = entry('Alice', { position: { x: 1, y: 2 } }), many = Array.from({ length: BUDDY_LIMITS.count + 3 }, (_, i) => entry(`桌宠${i}`));
  const list = parseRegistry(JSON.stringify({ buddies: [a, { ...a, name: '别名' }, entry('alice'), entry(''), { ...entry('坏位置'), position: { x: 'a' } }, ...many] }));
  assert.equal(list.length, BUDDY_LIMITS.count);
  assert.deepEqual(list.slice(0, 2).map(b => [b.name, b.position]), [['Alice', { x: 1, y: 2 }], ['坏位置', null]]);
  assert.equal(new Set(list.map(b => b.id)).size, list.length);
  const round = parseRegistry(serializeRegistry(list));
  assert.deepEqual(round, list);
  const saved = JSON.parse(serializeRegistry([{ ...a, agent: {}, note: {}, pet: {} }]));
  assert.equal(saved.version, 2); assert.deepEqual(saved.squads, []); assert.deepEqual(Object.keys(saved.buddies[0]), ['id', 'name', 'role', 'look', 'position']);
});

test('新建与改名：不重名（忽略大小写）、数量有上限、默认名和颜色避开已有', () => {
  const list = [entry('Alice'), entry('桌宠2', { look: { color: 'orange', style: 'short' } })];
  assert.throws(() => assertUniqueName(list, 'ALICE'), /已经有一只叫「ALICE」/);
  assert.doesNotThrow(() => assertUniqueName(list, 'alice', list[0].id));
  assert.throws(() => createBuddyEntry({ name: ' alice ' }, list), /已经有/);
  const made = createBuddyEntry({ name: '资料员', role: '读附件', look: { color: 'blue', style: 'mascot' } }, list);
  assert.match(made.id, /^[0-9a-f-]{36}$/); assert.equal(made.position, null); assert.equal(made.look.style, 'mascot');
  assert.throws(() => createBuddyEntry({ name: '再来' }, Array.from({ length: BUDDY_LIMITS.count }, (_, i) => entry(`n${i}`))), /最多同时养/);
  assert.deepEqual(suggestProfile(list), { name: '桌宠3', role: '', look: { color: 'blue', style: 'short' } });
  assert.equal(suggestProfile([entry('x'), entry('桌宠2')]).look.color, 'orange');
});

test('出生位置：从右下角开始，依次避开已有桌宠且不越出工作区', () => {
  const area = { x: 0, y: 0, width: 400, height: 300 }, size = BUDDY_LAYOUT, taken = [];
  for (let i = 0; i < 6; i++) {
    const p = spawnPosition(taken, area, size);
    assert.ok(p.x >= area.x && p.y >= area.y && p.x + size.width <= area.x + area.width && p.y + size.height <= area.y + area.height);
    assert.ok(!taken.some(q => Math.abs(q.x - p.x) < size.width && Math.abs(q.y - p.y) < size.height), `第 ${i + 1} 只与已有重叠`);
    taken.push(p);
  }
  assert.deepEqual(taken[0], { x: 400 - size.width - 16, y: 300 - size.height - 8 });
  assert.equal(taken[1].y, taken[0].y); assert.ok(taken[1].x < taken[0].x);
  const tiny = { x: 0, y: 0, width: 100, height: 100 };
  assert.deepEqual(spawnPosition([spawnPosition([], tiny, size)], tiny, size), spawnPosition([], tiny, size));
});

test('人设写在权限规则之前，且不替换原有规则', () => {
  const base = agentPrompt('DeepSeek'), persona = agentPrompt('DeepSeek', { name: '资料员', role: '负责读附件，提炼要点。' });
  assert.match(persona, /^你是纸间桌宠「资料员」，由 DeepSeek 模型驱动/);
  assert.match(persona, /负责读附件，提炼要点。你不是/);
  const rules = base.slice(base.indexOf('你不是'));
  assert.ok(rules.length > 50); assert.ok(persona.endsWith(rules));
  assert.ok(persona.indexOf('资料员') < persona.indexOf(rules));
  assert.ok(!agentPrompt('DeepSeek', { name: '甲', role: '' }).includes('角色与分工'));
});

test('每只桌宠的会话拿到自己的系统提示，改设定从下一次会话起生效', async t => {
  const prompts = [];
  const agent = new BuddyAgent({ inbox: '.', label: 'DeepSeek', persona: { name: '甲', role: '' }, createSession: async ({ systemPrompt }) => {
    prompts.push(systemPrompt); return { send: async () => {}, close: async () => {}, interrupt: async () => {} };
  } });
  t.after(() => agent.dispose());
  agent.send('你好');
  for (let i = 0; i < 200 && !prompts.length; i++) await new Promise(r => setTimeout(r, 5));
  assert.match(prompts[0], /「甲」/);
  agent.setPersona({ name: '乙', role: '写周报' });
  assert.equal(prompts.length, 1);
});

test('DeepSeek 会话把传入的系统提示作为首条 system 消息', async t => {
  const bodies = [];
  const fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const data = `data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}${NL}${NL}data: [DONE]${NL}${NL}`;
    return new Response(data, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const events = [];
  const s = await createDeepSeekSession({ apiKey: 'sk-fixture-not-real', fetch, retryDelay: 1, systemPrompt: '你是测试桌宠「丙」', onEvent: e => events.push(e), onTool: async () => ({}) });
  t.after(() => s.close());
  await s.send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '在吗' }] } });
  for (let i = 0; i < 200 && !events.some(e => e.type === 'result'); i++) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(bodies[0].messages[0], { role: 'system', content: '你是测试桌宠「丙」' });
});
