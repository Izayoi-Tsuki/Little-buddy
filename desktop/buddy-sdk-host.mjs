import { randomUUID } from 'node:crypto';
import { query, accessTokenFromEnv, createSdkMcpServer, tool, hasResolvableQoderWorkerRuntime, shutdownDaemon } from '@qoder-ai/qoder-agent-sdk';
import { z } from 'zod';
import { qoderOptions, InputQueue } from './buddy-qoder-policy.mjs';
import { SDK_TOOL_NAMES } from './buddy-agent.mjs';

const port = process.parentPort;
if (!port) throw new Error('SDK 宿主仅能由文件桌宠启动');
const post = data => port.postMessage(data);
let options, q, input, closing = false, probe = false;
const calls = new Map();
const event = value => { if (!closing) post({ type: 'event', value }); };
const fatalCode = error => /auth|token|401|403/i.test(`${error?.code ?? ''} ${error?.name ?? ''} ${error?.message ?? ''}`) ? 'AUTH_FAILED' : 'SDK_FAILED';
function businessTool(name, schema, description, readOnly = false) {
  return tool(name, description, schema, async args => {
    try {
      const id = randomUUID();
      const value = await new Promise((resolve, reject) => { calls.set(id, { resolve, reject }); post({ type: 'tool', id, name, args }); });
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  }, { annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } });
}
function server() {
  return createSdkMcpServer({ name: 'buddy', tools: [
    businessTool('read_attachment', { id: z.string().max(100) }, '读取本次消息附带的附件 ID；只读小型 UTF-8 文本，其他文件返回信息。', true),
    businessTool('copy_attachment', { id: z.string().max(100), action: z.enum(['copy', 'archive', 'rename']), newName: z.string().max(120).optional() }, '复制、归档附件副本或重命名另存；必须等待用户确认，原文件不动。'),
    businessTool('save_text', { name: z.string().max(120), content: z.string().max(131072) }, '生成 txt/md/csv/tsv/json 文本；必须等待用户查看完整内容与位置并确认，仅新建文件。'),
    businessTool('list_squad_files', {}, '列出小队文件夹里的文件；仅在消息附带小队信息时可用。', true),
    businessTool('read_squad_file', { name: z.string().max(120) }, '按文件名读取小队文件夹里的小型 UTF-8 文本；不接受路径。', true),
    businessTool('save_squad_file', { name: z.string().max(120), content: z.string().max(131072) }, '在小队文件夹新建 txt/md/csv/tsv/json 文本；只新建不覆盖，同名自动加序号，无需确认。'),
    businessTool('dispatch_task', { member: z.string().max(40), instruction: z.string().max(4000), with_attachment: z.boolean().optional() },
      '带队者把一项具体任务派给同队成员，等待并返回它的结果；一次只派一项。with_attachment 为 true 时把本次附件一并交给成员。'),
  ] });
}
async function consume() {
  let responseId = null;
  try {
    for await (const message of q) {
      if (closing) break;
      if (message.type === 'stream_event' && !message.parent_tool_use_id) {
        if (message.event.type === 'message_start') responseId = randomUUID();
        if (message.event.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') {
          responseId ??= randomUUID(); event({ type: 'text', id: responseId, text: message.event.delta.text ?? '' });
        }
      } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
        if (message.error) { post({ type: 'fatal', code: fatalCode({ code: message.error }) }); break; }
        const content = message.message.content ?? [], text = content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (text) event({ type: 'text', id: responseId ?? message.uuid ?? randomUUID(), text, replace: true });
        if (content.some(block => block.type === 'tool_use')) event({ type: 'activity', status: 'tool' });
        responseId = null;
      } else if (message.type === 'system' && message.subtype === 'init') {
        // 对实际 runtime 再验工具清单，出现额外能力时立即失败关闭。
        if ((message.tools ?? []).some(name => !SDK_TOOL_NAMES.includes(name))) throw new Error('工具权限清单与桌宠策略不一致');
        event({ type: 'activity', status: 'init' });
      } else if (message.type === 'result') {
        event({ type: 'result', ok: message.subtype === 'success' && !message.is_error,
          auth: /auth|401|403/i.test(String(message.error_code ?? '')) }); responseId = null;
      } else if (message.type === 'system' && message.subtype === 'api_retry') event({ type: 'activity', status: 'retry' });
    }
    if (!closing) post({ type: 'fatal', code: 'STREAM_ENDED' });
  } catch (error) { if (!closing) post({ type: 'fatal', code: fatalCode(error) }); }
}
async function close() {
  if (closing) return; closing = true; input?.close();
  for (const call of calls.values()) call.reject(new Error('会话已关闭，本次工具取消')); calls.clear();
  try { await q?.close(); await shutdownDaemon(); } catch { /* 退出只回收本宿主，不展示可能含敏感上下文的 SDK 日志。 */ }
  process.exit(0);
}
port.on('message', async ({ data }) => {
  if (!data || typeof data !== 'object' || closing) return;
  try {
    if (data.type === 'init') {
      if (options) throw new Error('重复初始化');
      probe = data.probe === true;
      const available = hasResolvableQoderWorkerRuntime(); if (!available) throw new Error('SDK runtime 未安装');
      const systemPrompt = typeof data.systemPrompt === 'string' && data.systemPrompt.length <= 8000 ? data.systemPrompt : undefined;
      options = qoderOptions({ auth: accessTokenFromEnv(), cwd: data.cwd, configDir: data.configDir, server: server(), systemPrompt });
      post({ type: 'ready', metadata: { sdk: '1.0.59', runtime: '1.1.83', platform: process.platform, available, probe } });
    } else if (data.type === 'send') {
      if (probe || !options || data.value?.type !== 'user') throw new Error('当前宿主不能接收指令');
      if (!q) { input = new InputQueue(); q = query({ prompt: input, options }); void consume(); }
      input.push(data.value); post({ type: 'ack', id: data.id, ok: true });
    } else if (data.type === 'interrupt') {
      if (q) await q.interrupt(); post({ type: 'ack', id: data.id, ok: true });
    } else if (data.type === 'tool-result') {
      const call = calls.get(data.id); if (!call) return; calls.delete(data.id);
      if (data.ok) call.resolve(data.value); else call.reject(new Error(data.error || '工具未完成'));
    } else if (data.type === 'close') await close();
  } catch (error) {
    if (data.id) post({ type: 'ack', id: data.id, ok: false, code: fatalCode(error) });
    else post({ type: 'fatal', code: fatalCode(error) });
  }
});
