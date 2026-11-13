import { utilityProcess } from 'electron';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { AGENT_TOOLS } from './buddy-agent.mjs';

// SDK 与其 Worker runtime 留在独立 Node 宿主，避免阻塞或终止 Electron 主进程。
export async function createQoderSession({ root, directory, onEvent, onTool, probe = false, systemPrompt }) {
  const cwd = join(directory, 'agent-workspace'), configDir = join(directory, 'agent-config');
  await mkdir(cwd, { recursive: true }); await mkdir(configDir, { recursive: true });
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'QODER_PERSONAL_ACCESS_TOKEN']
    .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  if (probe) delete env.QODER_PERSONAL_ACCESS_TOKEN; // 离线资源检查不需要也不传入用户凭据。
  if (!probe && !env.QODER_PERSONAL_ACCESS_TOKEN?.trim()) throw Object.assign(new Error('auth required'), { code: 'AUTH_REQUIRED' });
  const child = utilityProcess.fork(join(root, 'desktop/buddy-sdk-host.mjs'), [], { env, stdio: 'pipe', serviceName: 'Papertrail Qoder Agent' });
  child.stdout?.resume(); child.stderr?.resume();
  const pending = new Map(); let closing = false, ended = false, readyResolve, readyReject, metadata;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = error => { readyReject(error); for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  const request = (type, value) => new Promise((resolve, reject) => {
    if (closing || ended) return reject(new Error('会话已关闭'));
    const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(new Error('SDK 控制请求超时')); }, 10000);
    pending.set(id, { resolve, reject, timer }); child.postMessage({ type, id, value });
  });
  child.on('message', async data => {
    if (closing || ended || !data || typeof data !== 'object') return;
    if (data.type === 'ready') { metadata = data.metadata; readyResolve(); }
    else if (data.type === 'ack') {
      const entry = pending.get(data.id); if (!entry) return; pending.delete(data.id); clearTimeout(entry.timer);
      if (data.ok) entry.resolve(data.value); else entry.reject(Object.assign(new Error('SDK 请求失败'), { code: data.code }));
    } else if (data.type === 'tool') {
      try {
        if (!AGENT_TOOLS.includes(data.name) || typeof data.id !== 'string' || JSON.stringify(data.args).length > 300000) throw new Error('无权执行这个工具');
        const value = await onTool(data.name, data.args);
        if (!closing && !ended) child.postMessage({ type: 'tool-result', id: data.id, ok: true, value });
      } catch (error) {
        if (!closing && !ended) child.postMessage({ type: 'tool-result', id: data.id, ok: false, error: error.message });
      }
    } else if (data.type === 'event') onEvent(data.value);
    else if (data.type === 'fatal') {
      const error = Object.assign(new Error('SDK 启动失败'), { code: data.code });
      fail(error); onEvent({ type: 'fatal', code: data.code });
    }
  });
  child.once('exit', () => { ended = true; fail(new Error('SDK 宿主已退出')); if (!closing) onEvent({ type: 'fatal', code: 'HOST_EXIT' }); });
  child.once('spawn', () => child.postMessage({ type: 'init', cwd, configDir, probe, systemPrompt }));
  const startupTimer = setTimeout(() => { fail(new Error('SDK 宿主初始化超时')); child.kill(); }, 15000);
  try { await ready; } catch (error) { closing = true; child.kill(); throw error; } finally { clearTimeout(startupTimer); }
  return {
    metadata,
    send: input => request('send', input),
    interrupt: () => request('interrupt'),
    close: async () => {
      if (closing || ended) return;
      closing = true; fail(new Error('会话已关闭'));
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); }); child.postMessage({ type: 'close' });
      });
    },
  };
}
