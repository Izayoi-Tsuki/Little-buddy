import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeepSeekSession, DEEPSEEK_ENDPOINT, DEEPSEEK_MODEL, DEEPSEEK_TOOLS } from '../desktop/buddy-deepseek.mjs';
import { BuddyAgent, AGENT_TOOLS } from '../desktop/buddy-agent.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const KEY = 'sk-fixture-not-real';
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('测试等待超时');
}
// 把 SSE 切成很小的字节块，覆盖跨块的行与多字节 UTF-8。
function sse(chunks, { hold = false } = {}) {
  const bytes = new TextEncoder().encode(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + (hold ? '' : ': keep-alive\n\ndata: [DONE]\n\n'));
  return (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    if (!hold) controller.close();
    signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
  } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const text = (...parts) => parts.map(content => ({ choices: [{ delta: { content } }] }));
const call = (name, args, id = 'call_1') => {
  const raw = JSON.stringify(args), half = Math.ceil(raw.length / 2);
  return [{ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: raw.slice(0, half) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: raw.slice(half) } }] }, finish_reason: 'tool_calls' }] }];
};
function fakeApi(...replies) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    const reply = replies.shift(); if (!reply) throw new Error('没有预置回复');
    return reply(url, init);
  };
  return { fetch, requests };
}
const userInput = value => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: value }] } });
async function session(t, api, extra = {}) {
  const events = [], tools = [];
  const s = await createDeepSeekSession({ apiKey: KEY, fetch: api.fetch, retryDelay: 1, onEvent: e => events.push(e),
    onTool: async (name, args) => { tools.push({ name, args }); return { ok: true }; }, ...extra });
  t.after(() => s.close()); return { s, events, tools };
}

test('没有 DEEPSEEK_API_KEY 时不建立会话，也不发网络请求', async () => {
  const api = fakeApi();
  await assert.rejects(createDeepSeekSession({ apiKey: '  ', fetch: api.fetch, onEvent() {}, onTool() {} }), e => e.code === 'AUTH_REQUIRED');
  assert.equal(api.requests.length, 0);
});

test('请求固定发往 DeepSeek，只声明三个受限工具，密钥只在请求头里', async t => {
  const api = fakeApi(sse(text('好'))), { s, events } = await session(t, api);
  await s.send(userInput('你好')); await waitFor(() => events.some(e => e.type === 'result'));
  const [{ url, init, body }] = api.requests;
  assert.equal(url, DEEPSEEK_ENDPOINT); assert.equal(init.method, 'POST'); assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(body.model, DEEPSEEK_MODEL); assert.equal(body.stream, true); assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.tools.map(tool => tool.function.name), [...AGENT_TOOLS]); assert.deepEqual(DEEPSEEK_TOOLS, body.tools);
  assert.ok(!init.body.includes(KEY)); assert.ok(!JSON.stringify(events).includes(KEY));
  assert.match(body.messages[0].content, /不允许执行命令/);
});

test('回复按流式片段到达，多轮对话保留上下文', async t => {
  const api = fakeApi(sse(text('你', '好，', '我是桌宠')), sse(text('你刚才说了你好'))), { s, events } = await session(t, api);
  await s.send(userInput('你好')); await waitFor(() => events.some(e => e.type === 'result'));
  const chunks = events.filter(e => e.type === 'text');
  assert.deepEqual(chunks.map(e => e.text), ['你', '好，', '我是桌宠']); assert.equal(new Set(chunks.map(e => e.id)).size, 1);
  await s.send(userInput('我刚才说了什么？')); await waitFor(() => events.filter(e => e.type === 'result').length === 2);
  assert.deepEqual(api.requests[1].body.messages.slice(1).map(m => [m.role, m.content]),
    [['user', '你好'], ['assistant', '你好，我是桌宠'], ['user', '我刚才说了什么？']]);
});

test('分片到达的工具调用会拼好参数，执行结果回传后继续回复', async t => {
  const api = fakeApi(sse(call('read_attachment', { id: '附件-1' })), sse(text('读完了')));
  const { s, events, tools } = await session(t, api);
  await s.send(userInput('总结附件')); await waitFor(() => events.some(e => e.type === 'result'));
  assert.deepEqual(tools, [{ name: 'read_attachment', args: { id: '附件-1' } }]);
  const messages = api.requests[1].body.messages;
  assert.equal(messages.at(-2).tool_calls[0].function.name, 'read_attachment');
  assert.deepEqual(messages.at(-1), { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' });
  assert.ok(events.some(e => e.type === 'activity' && e.status === 'tool')); assert.equal(events.at(-1).ok, true);
});

test('未声明的工具与损坏参数不会进入本地执行', async t => {
  const bad = [{ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'read_attachment', arguments: '{坏' } }] } }] }];
  const api = fakeApi(sse([...call('Bash', { command: 'dir' }), ...bad]), sse(text('好的')));
  const { s, events, tools } = await session(t, api);
  await s.send(userInput('执行命令')); await waitFor(() => events.some(e => e.type === 'result'));
  const replies = api.requests[1].body.messages.filter(m => m.role === 'tool');
  assert.equal(tools.length, 0); assert.deepEqual(replies.map(m => m.tool_call_id), ['call_1', 'c2']);
  assert.match(replies[0].content, /权限/); assert.match(replies[1].content, /JSON/);
});

test('401 断开会话，402/429/5xx 给出原因并保持历史一致', async t => {
  const auth = await session(t, fakeApi(async () => new Response('{"error":"bad key"}', { status: 401 })));
  await auth.s.send(userInput('你好')); await waitFor(() => auth.events.length);
  assert.deepEqual(auth.events, [{ type: 'fatal', code: 'AUTH_FAILED' }]);
  const api = fakeApi(async () => new Response('', { status: 402 }), async () => new Response('', { status: 503 }), sse(text('恢复了')));
  const { s, events } = await session(t, api);
  await s.send(userInput('第一句')); await waitFor(() => events.some(e => e.type === 'result'));
  assert.deepEqual(events.at(-1), { type: 'result', ok: false, reason: 'balance' });
  await s.send(userInput('第二句')); await waitFor(() => events.filter(e => e.type === 'result').length === 2);
  assert.ok(events.some(e => e.type === 'activity' && e.status === 'retry')); assert.equal(events.at(-1).ok, true);
  // 失败回合撤出历史，重试请求只带第二句。
  assert.deepEqual(api.requests[2].body.messages.slice(1), [{ role: 'user', content: '第二句' }]);
  const offline = await session(t, fakeApi(async () => { throw new TypeError('fetch failed'); }));
  await offline.s.send(userInput('断网')); await waitFor(() => offline.events.length);
  assert.deepEqual(offline.events, [{ type: 'result', ok: false, reason: 'network' }]);
});

test('停止会中断流式回复，关闭后不再产生事件', async t => {
  const api = fakeApi(sse(text('前半'), { hold: true })), { s, events } = await session(t, api);
  await s.send(userInput('写长文')); await waitFor(() => events.some(e => e.type === 'text'));
  await s.interrupt(); await waitFor(() => events.some(e => e.type === 'result'));
  assert.deepEqual(events.at(-1), { type: 'result', ok: false, reason: 'stopped' });
  const idle = await session(t, fakeApi(sse([], { hold: true })), { idleTimeout: 20 });
  await idle.s.send(userInput('等待')); await waitFor(() => idle.events.length);
  assert.deepEqual(idle.events, [{ type: 'result', ok: false, reason: 'timeout' }]);
  const late = await session(t, fakeApi(sse(text('不应出现'), { hold: true })));
  await late.s.send(userInput('关闭')); await late.s.close(); await new Promise(r => setTimeout(r, 20));
  assert.equal(late.events.length, 0); await assert.rejects(late.s.send(userInput('再发')), /已关闭/);
});

test('接入 BuddyAgent：读取附件、写入前等待确认、原文件不变', async t => {
  const base = join(ROOT, '.buddy-test-data', 'deepseek'); await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'case-')), path = join(dir, '笔记.txt'), inbox = join(dir, '收纳箱');
  await writeFile(path, '桌宠测试内容');
  let attachmentId;
  const api = fakeApi(
    (url, init) => { attachmentId = JSON.parse(JSON.parse(init.body).messages.at(-1).content.split('：').at(-1)).id; return sse(call('read_attachment', { id: attachmentId }))(url, init); },
    sse(text('内容是：桌宠测试内容')),
    (url, init) => sse(call('copy_attachment', { id: attachmentId, action: 'copy' }, 'call_2'))(url, init),
    sse(text('已为你保存副本')),
  );
  const agent = new BuddyAgent({ inbox, label: 'DeepSeek', createSession: options => createDeepSeekSession({ ...options, apiKey: KEY, fetch: api.fetch, retryDelay: 1 }) });
  t.after(() => agent.dispose());
  await agent.receive(path); agent.send('总结附件');
  await waitFor(() => agent.state.phase === 'done');
  assert.equal(agent.snapshot().provider, 'DeepSeek'); assert.equal(agent.state.messages.at(-1).text, '内容是：桌宠测试内容');
  assert.match(api.requests[1].body.messages.at(-1).content, /桌宠测试内容/); assert.ok(!api.requests[0].body.messages.at(-1).content.includes(path));
  agent.send('把它复制一份'); await waitFor(() => agent.state.phase === 'confirming');
  assert.deepEqual(await readdir(dir), ['笔记.txt']);
  agent.approve({ id: agent.state.approval.id, allow: true }); await waitFor(() => agent.state.phase === 'done');
  const copied = agent.state.messages.find(m => m.role === 'system').text.match(/已保存：(.+?)；/)[1];
  assert.equal(await readFile(copied, 'utf8'), '桌宠测试内容'); assert.equal(await readFile(path, 'utf8'), '桌宠测试内容');
  assert.match(api.requests[3].body.messages.at(-1).content, /output/);
});
