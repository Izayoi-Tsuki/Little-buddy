import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, utimes, symlink, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDDY_LAYOUT, NOTE_SIZE, buddyHitTest, clampBuddyPosition, notePosition, baseName, splitName, classifyFile, isTextFile, formatSize,
  sanitizeFileName, candidateName, BUDDY_ACTIONS, outputPlan, createBuddyState, buddyTransition, parseSummon, parseReplyTarget,
  TALK_ROUNDS, similarity, isQuestion, openTalk, talkGate } from '../src/file-buddy.mjs';
import { rankBars } from '../src/buddy-rank.mjs';
import { describeFile, inspectFile, copyIntoInbox } from '../desktop/file-actions.mjs';
import { nativeAlive, windowVisible } from '../desktop/buddy-lifecycle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
async function fixture(name = '示例.txt', text = '你好\n桌宠') {
  const base = join(ROOT, '.buddy-test-data', 'units'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-')), path = join(dir, name); await writeFile(path, text, 'utf8');
  return { dir, path, text, file: await describeFile(path), inbox: join(dir, '收纳箱') };
}

test('已销毁窗口和退出中的实例不查询 isVisible，避免原生对象销毁异常', () => {
  let visibleCalls = 0;
  const gone = { isDestroyed: () => true, isVisible: () => { throw new Error('Object has been destroyed'); } };
  const live = { isDestroyed: () => false, isVisible: () => { visibleCalls++; return true; } };
  assert.equal(nativeAlive(null), false); assert.equal(nativeAlive(gone), false); assert.equal(nativeAlive(live), true);
  for (let i = 0; i < 100; i++) { assert.equal(windowVisible(gone), false); assert.equal(windowVisible(live, true), false); }
  assert.equal(visibleCalls, 0); assert.equal(windowVisible(live), true); assert.equal(visibleCalls, 1);
});

test('文件垫覆盖接收区域和角色，不拦截透明留白', () => {
  assert.equal(BUDDY_LAYOUT.width, 80); assert.equal(BUDDY_LAYOUT.height, 88);
  for (const [x, y] of [[38, 39], [10, 9], [69, 63], [6, 67], [73, 84]]) assert.equal(buddyHitTest(x, y), true);
  for (const [x, y] of [[0, 0], [79, 39], [5, 68], [38, 87], [38, 65]]) assert.equal(buddyHitTest(x, y), false);
});
test('斜杠召唤按最长的同队名字匹配，名字后可以不空格；军衔带队三杠、成员一杠、同伴两杠', () => {
  const names = ['甲', '甲乙', 'Big Cat'];
  assert.deepEqual(parseSummon('/乙 帮我看看', ['乙']), { to: '乙', text: '帮我看看', known: true });
  assert.deepEqual(parseSummon('/甲乙你好', names), { to: '甲乙', text: '你好', known: true });
  assert.deepEqual(parseSummon('/甲 你好', names), { to: '甲', text: '你好', known: true });
  assert.deepEqual(parseSummon('/Big Cat  午饭吃什么', names), { to: 'Big Cat', text: '午饭吃什么', known: true });
  assert.deepEqual(parseSummon('/丙 在吗', names), { to: '丙', text: '在吗', known: false });
  assert.deepEqual(parseSummon('/甲', names), { to: '甲', text: '', known: true });
  for (const text of ['你好 /甲', '/ 甲', '/', '', null]) assert.equal(parseSummon(text, names), null);
  assert.deepEqual([null, { lead: true, led: true }, { lead: false, led: true }, { lead: false, led: false }].map(rankBars), [0, 3, 1, 2]);
});
test('同伴回话用开头的「@对象」选择说给谁，没写或写了别人都回给对方', () => {
  assert.deepEqual(parseReplyTarget('@用户\n整理好了', '甲'), { to: 'user', text: '整理好了' });
  assert.deepEqual(parseReplyTarget('「@用户」：整理好了', '甲'), { to: 'user', text: '整理好了' });
  assert.deepEqual(parseReplyTarget('＠甲 收到', '甲'), { to: 'peer', text: '收到' });
  assert.deepEqual(parseReplyTarget('@Big Cat，收到', 'Big Cat'), { to: 'peer', text: '收到' });
  assert.deepEqual(parseReplyTarget('收到，@用户 稍等', '甲'), { to: 'peer', text: '收到，@用户 稍等' });
  assert.deepEqual(parseReplyTarget('@丙 你好', '甲'), { to: 'peer', text: '@丙 你好' });
  assert.deepEqual(parseReplyTarget('@用户', '甲'), { to: 'user', text: '' });
  assert.deepEqual(parseReplyTarget('', '甲'), { to: 'peer', text: '' });
  // 「@用户 求助」是卡住了请用户决定，和普通汇报分开。
  assert.deepEqual(parseReplyTarget('@用户 求助\n缺少文件', '甲'), { to: 'help', text: '缺少文件' });
  assert.deepEqual(parseReplyTarget('「@用户 求助」：没有权限', '甲'), { to: 'help', text: '没有权限' });
  assert.deepEqual(parseReplyTarget('@用户【求助】该选哪个版本', '甲'), { to: 'help', text: '该选哪个版本' });
  assert.deepEqual(parseReplyTarget('@用户 求助', '甲'), { to: 'help', text: '' });
  assert.deepEqual(parseReplyTarget('@甲 求助一下', '甲'), { to: 'peer', text: '求助一下' });
});
test('同伴对话门控：聊满句数、重复差不多的话、连着反问都停下来找用户', () => {
  assert.equal(TALK_ROUNDS, 4); assert.ok(similarity('帮我看看这份报告', '帮我看看这份报告！') > .99); assert.ok(similarity('今天天气不错', '下午三点开会') < .1);
  assert.deepEqual(['你说的是哪个？', '是这个吗', '好的。', '要不要?'].map(isQuestion), [true, true, false, true]);
  // 各说各的、不反问：第 4 句之前继续，到第 4 句的回话就停。
  let talk = openTalk('请整理一下周报', { origin: 'a' });
  assert.deepEqual([talk.round, talk.topic, talk.questions, talk.origin], [1, '请整理一下周报', 0, 'a']);
  for (const [i, text] of ['先列出本周完成的事项', '再补充下周计划', '最后写风险和需要的支持'].entries()) {
    const gate = talkGate(talk, text); assert.equal(gate.reason, null, text); talk = { ...gate.talk, round: talk.round + 1 }; assert.equal(talk.round, i + 2);
  }
  assert.equal(talkGate(talk, '我来汇总成一份初稿').reason, 'rounds');
  // 一句几乎一样就停；连着两句差不多也停。
  assert.equal(talkGate(openTalk('一直聊下去吧'), '一直聊下去吧！').reason, 'repeat');
  let loop = openTalk('附件打不开，请你再发一次');
  const first = talkGate(loop, '附件打不开，你再发一次给我'); assert.equal(first.reason, null); assert.equal(first.talk.repeats, 1);
  loop = { ...first.talk, round: 2 }; assert.equal(talkGate(loop, '附件打不开，你再发一次吧').reason, 'repeat');
  // 连着三句问句是互相反问；中间有一句不是问句就重新计。
  let ask = openTalk('你能帮我看看这个吗？');
  ask = { ...talkGate(ask, '你想让我看哪一部分？').talk, round: 2 }; assert.equal(talkGate(ask, '你觉得哪里最要紧呢').reason, 'questions');
  assert.equal(talkGate({ ...ask, questions: 0 }, '你觉得哪里最要紧呢').reason, null);
});
test('桌宠和便利贴在负坐标多屏、小屏、右下角均不越出工作区', () => {
  for (const area of [{ x: -1920, y: 20, width: 1920, height: 1040 }, { x: 0, y: 0, width: 640, height: 480 }]) {
    const p = clampBuddyPosition(null, area), edge = clampBuddyPosition({ x: 9999, y: -9999 }, area);
    for (const pos of [p, edge, clampBuddyPosition({ x: NaN }, area)]) {
      assert.ok(pos.x >= area.x && pos.x + BUDDY_LAYOUT.width <= area.x + area.width);
      assert.ok(pos.y >= area.y && pos.y + BUDDY_LAYOUT.height <= area.y + area.height);
      const note = notePosition({ ...pos, ...BUDDY_LAYOUT }, area);
      assert.ok(note.x >= area.x && note.x + NOTE_SIZE.width <= area.x + area.width);
      assert.ok(note.y >= area.y && note.y + NOTE_SIZE.height <= area.y + area.height);
    }
  }
});
test('分类、文件名和体积格式不依赖平台或大小写', () => {
  assert.equal(baseName('C:\\Desktop\\报告.PDF'), '报告.PDF'); assert.equal(baseName('/files/.env'), '.env');
  assert.deepEqual(splitName('.env'), { stem: '.env', ext: '' }); assert.equal(splitName('archive.tar.gz').ext, '.gz');
  for (const [name, category] of [['图.PNG', '图片'], ['文档.PDF', '文档'], ['数据.csv', '表格'], ['page.tsx', '代码'], ['无后缀', '其他'], ['a.lnk', '快捷方式']]) assert.equal(classifyFile(name), category);
  assert.equal(isTextFile('A.JSON'), true); assert.equal(isTextFile('A.PDF'), false);
  assert.equal(formatSize(0), '0 B'); assert.equal(formatSize(1536), '1.5 KB'); assert.equal(formatSize(1024 ** 3), '1.0 GB');
});
test('新名字是安全单个文件名，保留扩展名并拒绝空值与保留名称', () => {
  assert.equal(sanitizeFileName(' 副本 ', '.txt'), '副本.txt'); assert.equal(sanitizeFileName('副本.TXT', '.txt'), '副本.TXT');
  assert.equal(sanitizeFileName('../危险/名字?.png', '.txt'), '..危险名字.png.txt');
  for (const name of ['', '...', '   ', 'CON', 'aux.txt', 'COM1', 'LPT9.abc', 'a'.repeat(121)]) assert.throws(() => sanitizeFileName(name, '.txt'));
  assert.equal(candidateName('报告.txt', 1), '报告.txt'); assert.equal(candidateName('报告.txt', 2), '报告 (2).txt'); assert.equal(candidateName('.env', 2), '.env (2)');
});
test('输出规划只给收纳箱的固定相对目录，不移动原文件', () => {
  const file = { name: 'A.PNG' }, now = new Date(2026, 10, 7);
  assert.deepEqual(outputPlan('copy', file), { folder: ['收纳'], name: file.name });
  assert.deepEqual(outputPlan('archive', file, { now }), { folder: ['归档', '图片', '2026-11'], name: file.name });
  assert.deepEqual(outputPlan('rename', file, { newName: 'B' }), { folder: ['重命名'], name: 'B.PNG' });
  assert.throws(() => outputPlan('delete', file)); assert.equal(BUDDY_ACTIONS.length, 5);
  assert.ok(!BUDDY_ACTIONS.some(action => ['delete', 'exec', 'move'].includes(action.id)));
});
test('写入必经确认，读取立即执行；工作中拒绝二次确认、换文件和清空', () => {
  const idle = createBuddyState(), file = { name: 'a.txt', path: 'fixture' };
  const asking = buddyTransition(idle, { type: 'receive', file });
  assert.equal(idle.file, null); assert.equal(asking.phase, 'asking');
  assert.throws(() => buddyTransition(asking, { type: 'confirm' }));
  const confirming = buddyTransition(asking, { type: 'choose', action: 'copy', plan: {} });
  assert.equal(confirming.phase, 'confirming'); assert.equal(buddyTransition(confirming, { type: 'back' }).phase, 'asking');
  const working = buddyTransition(confirming, { type: 'confirm' }); assert.equal(working.phase, 'working');
  for (const type of ['confirm', 'receive', 'choose', 'dismiss', 'again', 'back']) assert.throws(() => buddyTransition(working, { type, file, action: 'copy' }));
  const done = buddyTransition(working, { type: 'succeed', result: { output: 'result' } });
  assert.equal(done.phase, 'done'); assert.equal(done.result.output, 'result'); assert.equal(buddyTransition(done, { type: 'again' }).phase, 'asking');
  assert.equal(buddyTransition(done, { type: 'dismiss' }).file, null);
  assert.equal(buddyTransition(asking, { type: 'choose', action: 'inspect' }).phase, 'working');
  assert.throws(() => buddyTransition(asking, { type: 'choose', action: 'exec' }));
  const failed = buddyTransition(working, { type: 'fail', error: 'test' }); assert.equal(failed.error, 'test'); assert.equal(buddyTransition(failed, { type: 'back' }).phase, 'asking');
});
test('文件描述拒绝相对路径、空值、缺失文件和文件夹', async () => {
  const f = await fixture();
  assert.equal(f.file.category, '文档'); assert.equal(f.file.name, '示例.txt'); assert.ok(f.file.identity);
  for (const value of ['', 'relative.txt', {}, join(f.dir, 'missing.txt'), f.dir]) await assert.rejects(describeFile(value));
});
test('查看信息读取文本行数，不写入或启动文件', async () => {
  const f = await fixture(); const before = await readdir(f.dir); const result = await inspectFile(f.file);
  assert.equal(result.kind, 'info'); assert.ok(result.rows.some(([key, value]) => key === '文本行数' && value === '2'));
  assert.deepEqual(await readdir(f.dir), before); assert.equal(await readFile(f.path, 'utf8'), f.text);
});
test('副本以独占方式新建，同名序号和并发请求绝不覆盖已有内容', async () => {
  const f = await fixture(); const plan = outputPlan('copy', f.file);
  const first = await copyIntoInbox(f.file, plan, f.inbox); await writeFile(first.output, '用户原有副本', 'utf8');
  const results = await Promise.all(Array.from({ length: 5 }, () => copyIntoInbox(f.file, plan, f.inbox)));
  assert.equal(new Set(results.map(r => r.output)).size, 5); assert.ok(results.every(r => r.renamed));
  assert.equal(await readFile(first.output, 'utf8'), '用户原有副本'); assert.equal(await readFile(f.path, 'utf8'), f.text);
  for (const r of results) assert.equal(await readFile(r.output, 'utf8'), f.text);
});
test('归档和重命名都生成副本，原位置、内容、修改时间保持不变', async () => {
  const f = await fixture();
  const archive = await copyIntoInbox(f.file, outputPlan('archive', f.file, { now: new Date(2026, 10, 7) }), f.inbox);
  const renamed = await copyIntoInbox(f.file, outputPlan('rename', f.file, { newName: '新名字' }), f.inbox);
  assert.equal(archive.output, join(f.inbox, '归档', '文档', '2026-11', '示例.txt'));
  assert.equal(renamed.output, join(f.inbox, '重命名', '新名字.txt')); assert.equal(await readFile(f.path, 'utf8'), f.text);
  assert.deepEqual(await describeFile(f.path), f.file);
});
test('等待期间内容或文件身份变化，拒绝继续处理', async () => {
  const f = await fixture(); await writeFile(f.path, '已经更改'); await assert.rejects(copyIntoInbox(f.file, outputPlan('copy', f.file), f.inbox), /发生了变化/);
  const original = await describeFile(f.path), replacement = join(f.dir, 'replacement.txt');
  await writeFile(replacement, '已经更改'); await utimes(replacement, new Date(original.modified), new Date(original.modified));
  await rename(f.path, join(f.dir, 'original.txt')); await rename(replacement, f.path);
  await assert.rejects(inspectFile(original), /发生了变化/);
});
test('输出穿越、绝对目录和文件名中的分隔符被拒绝，目录链接不会被写入', async () => {
  const f = await fixture();
  for (const plan of [{ folder: ['..'], name: 'a.txt' }, { folder: [f.dir], name: 'a.txt' }, { folder: ['收纳'], name: '../a.txt' }, { folder: ['收纳'], name: 'a:b.txt' }]) await assert.rejects(copyIntoInbox(f.file, plan, f.inbox), /收纳箱内/);
  const elsewhere = join(f.dir, '其他目录'); await mkdir(elsewhere); await mkdir(f.inbox); await symlink(elsewhere, join(f.inbox, '收纳'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyIntoInbox(f.file, outputPlan('copy', f.file), f.inbox), /普通文件夹/);
  assert.deepEqual(await readdir(elsewhere), []);
});
test('文件桌宠使用独立进程、数据目录和受限桥接，不把执行能力加到 Qoder 桌宠', async () => {
  const main = await readFile(join(ROOT, 'desktop/buddy-main.mjs'), 'utf8'), preload = await readFile(join(ROOT, 'desktop/buddy-preload.cjs'), 'utf8');
  assert.match(main, /Papertrail File Buddy/); assert.match(main, /contextIsolation: true, sandbox: true, nodeIntegration: false/);
  assert.match(main, /focusable: false/); assert.match(main, /trustedSender/); assert.match(main, /requestSingleInstanceLock/);
  assert.match(preload, /webUtils\.getPathForFile/); assert.doesNotMatch(preload, /require\(['"](?:fs|child_process|node:fs)/);
  assert.doesNotMatch(main, /QoderTranscriptObserver|DesktopRuntime/);
});
