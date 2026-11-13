import { SDK_TOOL_NAMES, agentPrompt } from './buddy-agent.mjs';

export function qoderOptions({ auth, cwd, configDir, server, env = process.env, systemPrompt = agentPrompt('Qoder') }) {
  const names = new Set(SDK_TOOL_NAMES);
  const selectedEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'QODER_PERSONAL_ACCESS_TOKEN']
    .filter(key => typeof env[key] === 'string').map(key => [key, env[key]]));
  return {
    auth, cwd, env: { ...selectedEnv, QODER_CONFIG_DIR: configDir },
    tools: [...SDK_TOOL_NAMES], allowedTools: [...SDK_TOOL_NAMES],
    disallowedTools: ['Bash', 'Write', 'Edit', 'Read', 'Glob', 'Grep', 'Agent', 'Skill', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Monitor', 'TaskCreate'],
    permissionMode: 'default', allowDangerouslySkipPermissions: false,
    settingSources: [], skills: [], extensions: [], plugins: [], memory: {}, evolution: {},
    strictMcpConfig: true, mcpServers: { buddy: server }, persistSession: false,
    includePartialMessages: true, maxTurns: 12,
    canUseTool: async (name, input, options) => names.has(name)
      ? { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID }
      : { behavior: 'deny', message: '桌宠仅允许受限附件工具；没有任意命令、目录读取或文件编辑权限。', toolUseID: options.toolUseID },
    hooks: { PreToolUse: [{ hooks: [async input => ({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: names.has(input.tool_name) ? 'defer' : 'deny',
      permissionDecisionReason: '桌宠附件工具白名单',
    } })] }] },
    systemPrompt,
  };
}

// 保留同一个异步输入流支持多轮；关闭时唤醒等待者，不让 SDK 宿主挂住。
export class InputQueue {
  constructor() { this.values = []; this.waiter = null; this.ended = false; }
  push(value) {
    if (this.ended) throw new Error('会话已关闭');
    if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve({ value, done: false }); }
    else this.values.push(value);
  }
  next() {
    if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false });
    if (this.ended) return Promise.resolve({ done: true });
    return new Promise(resolve => { this.waiter = resolve; });
  }
  close() { this.ended = true; this.values = []; if (this.waiter) { this.waiter({ done: true }); this.waiter = null; } }
  [Symbol.asyncIterator]() { return this; }
}
