import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuddyAgent, SDK_TOOL_NAMES, safeAgentError } from '../desktop/buddy-agent.mjs';
import { qoderOptions, InputQueue } from '../desktop/buddy-qoder-policy.mjs';
import { describeFile, readAttachment, generatedTextPlan, saveTextIntoInbox, AGENT_TEXT_LIMIT } from '../desktop/file-actions.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('测试等待超时');
}
async function fixture(name = '附件.txt', content = '仅当前附件的内容') {
  const base = join(ROOT, '.buddy-test-data', 'agent'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-')), path = join(dir, name); await writeFile(path, content);
  return { dir, path, content, file: await describeFile(path), inbox: join(dir, '收纳箱') };
}
function harness(t, inbox = join(ROOT, '.buddy-test-data', 'unused')) {
  const sessions = [];
  const agent = new BuddyAgent({ inbox, stopTimeout: 30, createSession: async callbacks => {
    const session = { ...callbacks, inputs: [], closeCount: 0, interrupts: 0,
      async send(input) { this.inputs.push(input); }, async close() { this.closeCount++; }, async interrupt() { this.interrupts++; } };
    sessions.push(session); return session;
  } });
  t.after(() => agent.dispose()); return { agent, sessions };
}
async function started(agent, sessions, text = '你好') { agent.send(text); await waitFor(() => sessions.at(-1)?.inputs.length > 0); return sessions.at(-1); }

test('无附件可聊天，同一会话多轮复用，流式与完整回复不重复', async t => {
  const { agent, sessions } = harness(t), session = await started(agent, sessions, '/按字面聊天');
  assert.equal(session.inputs[0].client_composed, true); assert.equal(session.inputs[0].priority, 'later');
  assert.ok(session.inputs[0].message.content[0].text.endsWith('null'));
  session.onEvent({ type: 'text', id: 'a', text: '你' }); session.onEvent({ type: 'text', id: 'a', text: '好' });
  session.onEvent({ type: 'text', id: 'a', text: '你好！', replace: true }); session.onEvent({ type: 'result', ok: true });
  await waitFor(() => agent.state.phase === 'done'); assert.equal(agent.state.messages[1].text, '你好！');
  agent.send('继续'); await tick(); assert.equal(sessions.length, 1); assert.equal(session.inputs.length, 2);
  session.onEvent({ type: 'text', id: 'b', text: 'x'.repeat(40000) }); assert.equal(agent.state.messages.at(-1).text.length, 32768);
  session.onEvent({ type: 'result', ok: true }); await tick(); assert.equal(agent.activeFile, null);
});

test('附件仅发送元信息，内容按当前附件 ID 读取，不接受其他工具或路径', async t => {
  const f = await fixture(), { agent, sessions } = harness(t, f.inbox); await agent.receive(f.path);
  assert.equal(sessions.length, 0); const session = await started(agent, sessions, '总结附件');
  const prompt = session.inputs[0].message.content[0].text;
  assert.ok(!prompt.includes(f.path)); assert.ok(!prompt.includes(f.content));
  assert.equal((await session.onTool('read_attachment', { id: agent.state.file.id })).content, f.content);
  await assert.rejects(session.onTool('Read', { path: f.path }), /权限/);
  await assert.rejects(session.onTool('read_attachment', { id: '其他附件', path: f.path }), /本次指令/);
  await assert.rejects(agent.receive(f.path), /当前指令/); assert.throws(() => agent.removeAttachment()); assert.throws(() => agent.send('重复'));
});

test('生成文本必经当前单次审批，拒绝、过期和重复确认不写入', async t => {
  const f = await fixture(), { agent, sessions } = harness(t, f.inbox), session = await started(agent, sessions);
  const job = session.onTool('save_text', { name: '总结.md', content: '<script>不会执行</script>' });
  assert.equal(agent.state.phase, 'confirming'); assert.equal(agent.state.approval.preview, '<script>不会执行</script>');
  assert.equal(agent.state.approval.output, join(f.inbox, '生成', '总结.md')); assert.deepEqual(await readdir(f.dir), ['附件.txt']);
  assert.throws(() => agent.approve({ id: 'wrong', allow: true })); assert.throws(() => agent.approve({ id: agent.state.approval.id, allow: 'true' }));
  const id = agent.state.approval.id; agent.approve({ id, allow: false }); await assert.rejects(job, /拒绝或取消/);
  assert.throws(() => agent.approve({ id, allow: true })); assert.deepEqual(await readdir(f.dir), ['附件.txt']);
  const approved = session.onTool('save_text', { name: '总结.md', content: '确认后的内容' });
  agent.approve({ id: agent.state.approval.id, allow: true }); const result = await approved;
  assert.equal(await readFile(result.output, 'utf8'), '确认后的内容'); assert.equal(await readFile(f.path, 'utf8'), f.content);
  assert.ok(agent.state.messages.at(-1).text.includes('已保存'));
});

test('副本写入使用当前附件，等待确认期间文件变化被拒绝', async t => {
  const f = await fixture(), { agent, sessions } = harness(t, f.inbox); await agent.receive(f.path); const session = await started(agent, sessions);
  const job = session.onTool('copy_attachment', { id: agent.state.file.id, action: 'copy' });
  await writeFile(f.path, '文件已经变化，不能复制'); agent.approve({ id: agent.state.approval.id, allow: true });
  await assert.rejects(job, /发生了变化/); assert.deepEqual(await readdir(f.dir), ['附件.txt']);
});

test('批准后同 tick 停止仍取消未开始写入；interrupt ACK 后无 result 会安全回收', async t => {
  const f = await fixture(), { agent, sessions } = harness(t, f.inbox), session = await started(agent, sessions);
  const job = session.onTool('save_text', { name: '取消.txt', content: '不要写' }); const rejected = assert.rejects(job, /取消/);
  agent.approve({ id: agent.state.approval.id, allow: true }); agent.stop(); await rejected;
  await waitFor(() => agent.state.phase === 'idle'); assert.equal(session.interrupts, 1); assert.equal(session.closeCount, 1);
  assert.deepEqual(await readdir(f.dir), ['附件.txt']); session.onEvent({ type: 'text', id: 'late', text: '旧回复' });
  assert.ok(!agent.state.messages.some(m => m.id === 'late'));
});

test('断连时等待进行中的本地工具安全结束，不能提前解锁新指令', async t => {
  const { agent, sessions } = harness(t), session = await started(agent, sessions), gate = deferred();
  agent.toolJob = gate.promise; session.onEvent({ type: 'fatal', code: 'SDK_FAILED' }); await tick();
  assert.equal(agent.state.phase, 'stopping'); assert.throws(() => agent.send('下一条'));
  gate.resolve(); await waitFor(() => agent.state.phase === 'failed'); agent.toolJob = null;
  assert.equal(session.closeCount, 1); assert.ok(!agent.state.error.includes('SDK_FAILED'));
});

test('result 不会批准尚待确认的写入，也不会无限挂起', async t => {
  const f = await fixture(), { agent, sessions } = harness(t, f.inbox), session = await started(agent, sessions);
  const job = session.onTool('save_text', { name: '未确认.txt', content: '未确认' }); const rejected = assert.rejects(job, /取消/);
  session.onEvent({ type: 'result', ok: true }); await rejected; await waitFor(() => agent.state.phase === 'done');
  assert.deepEqual(await readdir(f.dir), ['附件.txt']);
});

test('审批期间退出会拒绝写入、关闭会话，不再更新 UI', async t => {
  const f = await fixture(), { agent, sessions } = harness(t, f.inbox), session = await started(agent, sessions);
  const job = session.onTool('save_text', { name: '退出.txt', content: '未确认' }); const rejected = assert.rejects(job, /取消/);
  const revision = agent.state.revision; await agent.dispose(); await rejected;
  session.onEvent({ type: 'text', id: 'late', text: '旧回复' }); assert.equal(agent.state.revision, revision);
  assert.equal(session.closeCount, 1); assert.deepEqual(await readdir(f.dir), ['附件.txt']);
});

test('会话初始化期间退出仍等待并回收迟到的宿主，不发送指令', async () => {
  const gate = deferred(); let closes = 0, sends = 0;
  const agent = new BuddyAgent({ inbox: '.', createSession: () => gate.promise }); agent.send('未发送');
  let disposed = false; const quitting = agent.dispose().then(() => { disposed = true; }); await tick(); assert.equal(disposed, false);
  gate.resolve({ close: async () => { closes++; }, send: async () => { sends++; } }); await quitting;
  assert.equal(closes, 1); assert.equal(sends, 0);
});

test('初始化期间停止后可新建会话，迟到宿主不污染新回复', async t => {
  const gate = deferred(); let calls = 0, oldCloses = 0, oldSends = 0;
  const agent = new BuddyAgent({ inbox: '.', stopTimeout: 10, createSession: async () => {
    calls++; return calls === 1 ? gate.promise : { send: async () => {}, close: async () => {}, interrupt: async () => {} };
  } }); t.after(() => agent.dispose()); agent.send('旧轮'); const oldDispatch = agent.dispatchJob; agent.stop();
  await waitFor(() => agent.state.phase === 'idle'); agent.send('新轮');
  gate.resolve({ send: async () => { oldSends++; }, close: async () => { oldCloses++; } }); await oldDispatch; await tick();
  assert.equal(oldCloses, 1); assert.equal(oldSends, 0); assert.equal(agent.state.phase, 'working'); assert.equal(calls, 2);
});

test('停止的 result 会关闭旧会话，迟到文本不能进入下一轮', async t => {
  const { agent, sessions } = harness(t), old = await started(agent, sessions);
  agent.stop(); old.onEvent({ type: 'result', ok: true }); await waitFor(() => agent.state.phase === 'idle');
  assert.equal(old.closeCount, 1); await started(agent, sessions, '下一轮');
  old.onEvent({ type: 'text', id: 'late-after-stop', text: '不能出现' });
  assert.equal(sessions.length, 2); assert.ok(!agent.state.messages.some(m => m.id === 'late-after-stop'));
});

test('连续初始化期间停止再退出会回收所有迟到宿主', async () => {
  const first = deferred(), second = deferred(); let calls = 0, closes = 0;
  const agent = new BuddyAgent({ inbox: '.', stopTimeout: 10, createSession: () => ++calls === 1 ? first.promise : second.promise });
  agent.send('旧'); agent.stop(); await waitFor(() => agent.state.phase === 'idle'); agent.send('新');
  let ended = false; const quitting = agent.dispose().then(() => { ended = true; });
  const session = () => ({ close: async () => { closes++; }, send: async () => { throw new Error('不能发送'); } });
  second.resolve(session()); await tick(); assert.equal(ended, false); first.resolve(session()); await quitting; assert.equal(closes, 2);
});

test('新对话隔离旧回调，revision 单调增长，附件清空', async t => {
  const f = await fixture(), { agent, sessions } = harness(t, f.inbox); await agent.receive(f.path); const old = await started(agent, sessions);
  old.onEvent({ type: 'result', ok: true }); await tick(); const revision = agent.state.revision; await agent.reset();
  assert.ok(agent.state.revision > revision); assert.equal(agent.state.file, null); assert.deepEqual(agent.state.messages, []);
  await started(agent, sessions); old.onEvent({ type: 'fatal', code: 'AUTH_FAILED' }); old.onEvent({ type: 'text', id: 'late', text: '不能出现' });
  await assert.rejects(old.onTool('save_text', { name: '旧.txt', content: 'x' }), /过期/); assert.equal(agent.state.phase, 'working');
  assert.ok(!agent.state.messages.some(m => m.id === 'late'));
});

test('SDK 白名单、hook、环境与会话配置不暴露通用工具或 IDE 设置', async () => {
  const options = qoderOptions({ auth: { type: 'test' }, cwd: 'isolated', configDir: 'own-config', server: {}, env: { Path: 'node', UNRELATED_SECRET: 'discard', QODER_PERSONAL_ACCESS_TOKEN: 'fixture-token' } });
  assert.deepEqual(options.tools, SDK_TOOL_NAMES); assert.deepEqual(options.allowedTools, SDK_TOOL_NAMES);
  assert.equal(options.env.UNRELATED_SECRET, undefined); assert.equal(options.env.QODER_CONFIG_DIR, 'own-config');
  for (const key of ['settingSources', 'skills', 'extensions', 'plugins']) assert.deepEqual(options[key], []);
  assert.equal(options.persistSession, false); assert.equal(options.allowDangerouslySkipPermissions, false);
  assert.equal((await options.canUseTool('Bash', {}, {})).behavior, 'deny');
  assert.equal((await options.canUseTool(SDK_TOOL_NAMES[0], { id: 'x' }, {})).behavior, 'allow');
  const hook = options.hooks.PreToolUse[0].hooks[0]; assert.equal((await hook({ tool_name: 'Read' })).hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(!options.systemPrompt.includes('fixture-token')); assert.ok(!safeAgentError(new Error('credential fixture-token')).includes('fixture-token'));
});

test('异步输入队列保持多轮顺序、关闭唤醒等待者，结束后拒绝发送', async () => {
  const input = new InputQueue(); input.push('一'); input.push('二'); assert.equal((await input.next()).value, '一'); assert.equal((await input.next()).value, '二');
  const next = input.next(); input.push('三'); assert.equal((await next).value, '三');
  const waiting = input.next(); input.close(); assert.equal((await waiting).done, true); assert.equal((await input.next()).done, true);
  assert.throws(() => input.push('晚到')); assert.equal(input[Symbol.asyncIterator](), input);
});

test('附件读取仅有效小型 UTF-8；二进制、大文件、变化文件不假装解析', async () => {
  const f = await fixture(); assert.equal((await readAttachment(f.file)).content, f.content);
  const bad = await fixture('无效.txt', Buffer.from([0xff, 0xfe])); assert.match((await readAttachment(bad.file)).notice, /UTF-8/);
  const binary = await fixture('文档.pdf', '不是 PDF 解析'); assert.equal((await readAttachment(binary.file)).content, undefined);
  const large = await fixture('大.txt', 'x'.repeat(AGENT_TEXT_LIMIT + 1)); assert.match((await readAttachment(large.file)).notice, /128 KiB/);
  const empty = await fixture('空.txt', ''); assert.equal((await readAttachment(empty.file)).content, '');
  await writeFile(f.path, '已变化'); await assert.rejects(readAttachment(f.file), /变化/);
});

test('生成文本限制扩展名与 UTF-8 字节数，同名并发不覆盖，目录链接被拒绝', async () => {
  const f = await fixture(); assert.deepEqual(generatedTextPlan('总结.md', '中文'), { folder: ['生成'], name: '总结.md' });
  for (const name of ['运行.ps1', '程序.exe', '页面.html', 'CON.txt', '无后缀']) assert.throws(() => generatedTextPlan(name, 'x'));
  assert.throws(() => generatedTextPlan('大.txt', '中'.repeat(AGENT_TEXT_LIMIT / 2)), /128 KiB/);
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => saveTextIntoInbox('总结.txt', String(i), f.inbox)));
  assert.equal(new Set(results.map(r => r.output)).size, 4);
  for (let i = 0; i < results.length; i++) assert.equal(await readFile(results[i].output, 'utf8'), String(i));
  const elsewhere = join(f.dir, '其他目录'), linked = join(f.dir, '链接收纳箱'); await mkdir(elsewhere); await mkdir(linked);
  await symlink(elsewhere, join(linked, '生成'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveTextIntoInbox('不能写.txt', 'x', linked), /普通文件夹/); assert.deepEqual(await readdir(elsewhere), []);
});
