import { randomUUID } from 'node:crypto';
import { AGENT_TOOLS, agentPrompt } from './buddy-agent.mjs';

export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
export const DEEPSEEK_MODEL = 'deepseek-flash';
const fn = (name, description, properties, required) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } });
const id = { type: 'string', description: '本次消息附带的附件 ID' };
export const DEEPSEEK_TOOLS = Object.freeze([
  fn('read_attachment', '读取本次消息附带的附件；只读小型 UTF-8 文本，其他文件返回信息。', { id }, ['id']),
  fn('copy_attachment', '复制、归档附件副本或重命名另存；必须等待用户确认，原文件不动。', { id,
    action: { type: 'string', enum: ['copy', 'archive', 'rename'] }, newName: { type: 'string', description: '仅 rename 时使用的新文件名' } }, ['id', 'action']),
  fn('save_text', '生成 txt/md/csv/tsv/json 文本；必须等待用户查看完整内容与位置并确认，仅新建文件。', {
    name: { type: 'string', description: '带扩展名的文件名' }, content: { type: 'string', description: '完整文本内容' } }, ['name', 'content']),
  fn('list_squad_files', '列出小队文件夹里的文件；仅在消息附带小队信息时可用。', {}, []),
  fn('read_squad_file', '按文件名读取小队文件夹里的小型 UTF-8 文本；不接受路径。', {
    name: { type: 'string', description: '小队文件夹里的文件名' } }, ['name']),
  fn('save_squad_file', '在小队文件夹新建 txt/md/csv/tsv/json 文本；只新建不覆盖，同名自动加序号，无需确认。', {
    name: { type: 'string', description: '带扩展名的文件名' }, content: { type: 'string', description: '完整文本内容' } }, ['name', 'content']),
  fn('dispatch_task', '带队者把一项具体任务派给同队成员，等待并返回它的结果；一次只派一项。', {
    member: { type: 'string', description: '小队信息 members 里的成员名字' }, instruction: { type: 'string', description: '交给成员的完整任务说明' },
    with_attachment: { type: 'boolean', description: '为 true 时把本次消息附带的附件一并交给成员' } }, ['member', 'instruction']),
]);
const STREAM_LIMIT = 400000;
const failure = (code, fatal = false) => Object.assign(new Error(code), { code, fatal });
const statusFailure = status => status === 401 || status === 403 ? failure('AUTH_FAILED', true)
  : status === 402 ? failure('balance') : status === 429 ? failure('rate') : status >= 500 ? failure('server') : failure('request');

// 直接调用 DeepSeek Chat Completions；模型只能请求白名单里的业务工具，执行与审批仍由 BuddyAgent 负责。
export async function createDeepSeekSession({ onEvent, onTool, apiKey = process.env.DEEPSEEK_API_KEY, fetch: request = globalThis.fetch,
  model = DEEPSEEK_MODEL, maxRounds = 8, idleTimeout = 60000, retryDelay = 1000, systemPrompt = agentPrompt('DeepSeek') }) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) throw Object.assign(new Error('auth required'), { code: 'AUTH_REQUIRED' });
  const history = [{ role: 'system', content: systemPrompt }];
  let closed = false, interrupted = false, controller = null, running = null;
  const emit = event => { if (!closed) onEvent(event); };
  const halted = () => closed || interrupted;
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(failure('ABORTED')); }, { once: true });
  });

  async function open(signal) {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await request(DEEPSEEK_ENDPOINT, { method: 'POST', signal,
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: history, tools: DEEPSEEK_TOOLS, tool_choice: 'auto', thinking: { type: 'disabled' }, stream: true, max_tokens: 4096 }) });
      } catch (error) { throw signal.aborted ? failure('ABORTED') : failure('network'); }
      if (response.ok && response.body) return response;
      await response.body?.cancel().catch(() => {});
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) { emit({ type: 'activity', status: 'retry' }); await wait(retryDelay, signal); continue; }
      throw statusFailure(response.status);
    }
  }
  async function round() {
    const current = controller = new AbortController();
    const signal = current.signal; let timedOut = false, timer;
    const idle = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; current.abort(); }, idleTimeout); };
    const textId = randomUUID(), calls = []; let content = '', size = 0, ended = false;
    try {
      idle(); const response = await open(signal); idle();
      const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (!ended) {
        const { value, done } = await reader.read(); if (done) break;
        idle(); buffer += decoder.decode(value, { stream: true });
        for (let index; !ended && (index = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim(); if (data === '[DONE]') { ended = true; break; }
          let chunk; try { chunk = JSON.parse(data); } catch { throw failure('server'); }
          if (chunk.error) throw failure('server');
          const delta = chunk.choices?.[0]?.delta ?? {};
          if (typeof delta.content === 'string' && delta.content) { content += delta.content; size += delta.content.length; emit({ type: 'text', id: textId, text: delta.content }); }
          for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const slot = calls[Number.isInteger(call.index) && call.index >= 0 && call.index < 16 ? call.index : calls.length] ??= { id: '', name: '', arguments: '' };
            if (typeof call.id === 'string') slot.id = call.id;
            if (typeof call.function?.name === 'string') slot.name += call.function.name;
            if (typeof call.function?.arguments === 'string') { slot.arguments += call.function.arguments; size += call.function.arguments.length; }
          }
          if (size > STREAM_LIMIT) throw failure('request');
        }
      }
      if (!ended) await reader.cancel().catch(() => {});
      return { content, calls: calls.filter(Boolean).map(call => ({ id: call.id || `call_${randomUUID()}`, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } })) };
    } catch (error) {
      if (timedOut) throw failure('timeout');
      if (signal.aborted) throw failure('ABORTED');
      throw error.code ? error : failure('network');
    } finally { clearTimeout(timer); if (controller === current) controller = null; }
  }
  async function runTool(call) {
    let args;
    try { args = JSON.parse(call.function.arguments?.trim() || '{}'); } catch { return JSON.stringify({ error: '工具参数不是有效 JSON' }); }
    if (!AGENT_TOOLS.includes(call.function.name) || !args || typeof args !== 'object' || Array.isArray(args)) return JSON.stringify({ error: '此会话没有这个工具的权限' });
    try { return JSON.stringify(await onTool(call.function.name, args) ?? null); } catch (error) { return JSON.stringify({ error: error.message }); }
  }
  async function turn(text) {
    const start = history.length; history.push({ role: 'user', content: text });
    try {
      for (let count = 0; count < maxRounds; count++) {
        const { content, calls } = await round();
        if (halted()) throw failure('ABORTED');
        history.push({ role: 'assistant', content: content || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) { emit({ type: 'result', ok: true }); return; }
        emit({ type: 'activity', status: 'tool' });
        for (const call of calls) {
          const result = await runTool(call);
          if (halted()) throw failure('ABORTED');
          history.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
      }
      throw failure('rounds');
    } catch (error) {
      // 失败或停止的回合整体撤出历史，避免留下没有工具结果的 tool_calls。
      history.length = start;
      if (error.fatal) emit({ type: 'fatal', code: error.code });
      else emit({ type: 'result', ok: false, reason: error.code === 'ABORTED' ? 'stopped' : error.code });
    }
  }
  return {
    metadata: { provider: 'DeepSeek', model },
    send: async input => {
      if (closed) throw new Error('会话已关闭');
      if (running) throw new Error('上一条指令仍在处理');
      const text = input?.message?.content?.[0]?.text;
      if (input?.type !== 'user' || typeof text !== 'string') throw new Error('当前会话不能接收指令');
      interrupted = false; running = turn(text).finally(() => { running = null; });
    },
    interrupt: async () => { if (!running) return; interrupted = true; controller?.abort(); },
    close: async () => {
      if (closed) return;
      closed = true; interrupted = true; controller?.abort();
      await running?.catch(() => {});
    },
  };
}
