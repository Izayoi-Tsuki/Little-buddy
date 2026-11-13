import { formatSize, PHASES, parseSummon } from './file-buddy.mjs';
import { drawRank, rankBars } from './buddy-rank.mjs';
const bridge = window.fileBuddy, $ = id => document.getElementById(id);
let state = null, pending = false, suggestIndex = 0, suggestClosed = true, answering = null;
const entries = new Map();
const busy = () => ['working', 'confirming', 'stopping'].includes(state?.phase);
// 在小队里时，以「/名字」开头的输入是召唤同组成员：先由这只桌宠加工成要对同伴说的话再去传话。
const mates = () => state?.buddy?.squad?.mates ?? [];
// 点了求助卡片上的「我来回答」，输入框这一次发给求助的那只，不是普通聊天或召唤。
const answerMode = () => !!answering && state?.help?.id === answering;
const summonCall = () => !answerMode() && mates().length ? parseSummon($('chat-input').value, mates()) : null;
function error(e) { $('note-error').textContent = e.message ?? String(e); $('note-error').hidden = false; }
function controls() {
  const call = summonCall(), answer = answerMode();
  $('chat-send').disabled = pending || !$('chat-input').value.trim() || (!answer && busy());
  $('chat-send').textContent = answer ? '回答 ↗' : call ? '召唤 ↗' : '发送 ↗';
  for (const id of ['help-answer', 'help-continue', 'help-dismiss']) $(id).disabled = pending;
  $('chat-stop').hidden = !busy(); $('chat-stop').disabled = pending || state?.phase === 'stopping';
  $('chat-reset').disabled = pending || busy(); $('attachment-remove').disabled = pending || busy();
  $('confirm-go').disabled = pending || !state?.approval; $('confirm-back').disabled = pending || !state?.approval;
}
async function command(type, value) {
  if (!bridge || pending) return false;
  pending = true; $('note-error').hidden = true; controls();
  try { update(await bridge.command(type, value)); return true; }
  catch (e) { error(e); return false; }
  finally { pending = false; controls(); }
}
function update(data) {
  if (!data || (state && data.revision < state.revision)) return;
  const old = state, main = document.querySelector('main');
  const atBottom = main.scrollTop + main.clientHeight >= main.scrollHeight - 45;
  state = data;
  const provider = data.provider ?? 'Qoder', name = data.buddy?.name, speaker = name || provider;
  $('note-title').textContent = name ? `${name} · 便利贴` : '纸间便利贴'; document.title = $('note-title').textContent;
  $('note-title').title = data.buddy?.role ? `角色：${data.buddy.role}` : '还没有设定角色，点 ✎ 编辑';
  $('note-provider').textContent = `${provider} 云端推理 · 原文件不动`;
  squad(data.buddy?.squad);
  renderHelp(data.help, data.waiting);
  placeholder(); renderSuggest();
  $('note-provider').title = `由 ${provider} 模型服务处理指令与所需附件内容；不继承当前 IDE 对话。认证使用本机环境变量 ${provider === 'DeepSeek' ? 'DEEPSEEK_API_KEY' : 'PAT'}，不要在此粘贴凭据。`;
  $('note-file').textContent = data.file?.name ?? '可以直接聊天，也可以拖文件给我';
  $('note-file').title = data.file?.path ?? '';
  $('note-meta').textContent = data.file ? `${data.file.category} · ${formatSize(data.file.size)} · 原文件保留` : '附件在发送指令后才供 agent 读取';
  $('attachment-remove').hidden = !data.file;
  const messages = data.messages ?? [], ids = new Set(messages.map(message => message.id));
  for (const [id, entry] of entries) if (!ids.has(id)) { entry.node.remove(); entries.delete(id); }
  $('note-welcome').hidden = messages.length > 0;
  for (const message of messages) {
    let entry = entries.get(message.id);
    if (!entry) {
      const node = document.createElement('div'), label = document.createElement('span'), text = document.createElement('span');
      node.className = 'message'; node.dataset.role = message.role; label.className = 'message-label';
      node.append(label, text); $('note-messages').append(node); entry = { node, label, text }; entries.set(message.id, entry);
    }
    // 改名后旧消息的署名一并更新；带队者派来的任务和同队召唤时说的话标明来自谁、随话交来了哪个附件。
    const who = message.role === 'task' ? (message.kind === 'say' ? `「${message.from ?? '同伴'}」对你说` : message.kind === 'answer' ? '你对求助的回答'
        : `来自「${message.from ?? '带队者'}」的任务`)
        + (message.file ? ` · 附件：${message.file}` : '')
      : { user: '你', assistant: speaker, system: '提示' }[message.role] ?? '提示';
    if (entry.label.textContent !== who) entry.label.textContent = who;
    if (entry.text.textContent !== message.text) entry.text.textContent = message.text;
  }
  $('note-confirming').hidden = !data.approval;
  if (data.approval) {
    $('confirm-title').textContent = data.approval.title;
    $('confirm-path').textContent = data.approval.output;
    $('confirm-preview').hidden = data.approval.preview == null;
    $('confirm-preview').textContent = data.approval.preview ?? '';
    if (old?.approval?.id !== data.approval.id) requestAnimationFrame(() => {
      if (state?.approval?.id === data.approval.id) { $('note-confirming').scrollIntoView({ block: 'nearest' }); $('confirm-back').focus(); }
    });
  }
  $('note-activity').textContent = data.activity || `独立 ${provider} 会话 · ${PHASES[data.phase] ?? '待命'}`;
  if (data.error) error(new Error(data.error)); else if (old?.error) $('note-error').hidden = true;
  controls();
  if (atBottom && !data.approval) main.scrollTop = main.scrollHeight;
}
function placeholder() {
  $('chat-input').placeholder = answerMode() ? `回答「${state.help.asker}」的求助…  Enter 发送，Esc 取消`
    : mates().length ? '写下指令…  输入 /名字+要说的话 召唤同组成员' : '写下指令…  Enter 发送，Shift+Enter 换行';
}
// 求助卡片置顶在发起召唤的那只的便利贴上；被卡住的这一对只提示去哪张便利贴上回答。
function renderHelp(help, waiting) {
  $('note-help').hidden = !help;
  if (!help || help.id !== answering) answering = null;
  if (help) {
    $('help-topic').textContent = `「${help.asker}」和「${help.peer}」在聊：${help.topic || '（没有话题）'}`;
    $('help-reason').textContent = `卡在：${help.reason}`;
    $('help-text').textContent = `「${help.asker}」${help.asked ? '想问你' : '最后说'}：${help.text}`;
  }
  $('note-waiting').hidden = !waiting || !!help;
  $('note-waiting').textContent = waiting ? `等你决定 · 在「${waiting}」的便利贴上回答它们的求助` : '';
}
let squadKey = '';
// 军衔：带队三道杠、成员一道杠、同伴两道杠，颜色跟小队一致。
const RANK_WORDS = ['', '成员', '同伴', '带队'];
function squad(info) {
  $('note-squad').hidden = !info; const key = info ? `${info.color}:${info.lead}:${info.led}:${info.summary}` : '';
  if (key === squadKey) return; squadKey = key; if (!info) return;
  const bars = rankBars(info);
  $('note-squad-text').textContent = `${RANK_WORDS[bars]} · ${info.summary}`; $('note-rank').title = `军衔：${RANK_WORDS[bars]}`;
  const ctx = $('note-rank').getContext('2d'); ctx.clearRect(0, 0, 13, 12); ctx.imageSmoothingEnabled = false;
  drawRank(ctx, 0, 0, bars, info.color);
}
// 输入「/」时在输入框上方列出同组成员，点击、Tab 或 Enter 补全为「/名字 」。
function candidates() {
  const value = $('chat-input').value; if (answerMode() || !mates().length || !value.startsWith('/') || value.includes('\x0a')) return [];
  const query = value.slice(1), list = mates().filter(name => name.startsWith(query));
  return list.length === 1 && list[0] === query ? [] : list;
}
function renderSuggest() {
  const list = $('chat-suggest'), items = suggestClosed ? [] : candidates();
  suggestIndex = Math.min(suggestIndex, Math.max(0, items.length - 1)); list.hidden = !items.length;
  list.replaceChildren(...items.map((name, i) => {
    const item = document.createElement('li'), hint = document.createElement('small');
    item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(i === suggestIndex)); item.dataset.name = name;
    item.textContent = `/${name}`; hint.textContent = i === suggestIndex ? 'Tab 选中' : '召唤'; item.append(hint);
    item.addEventListener('mousedown', event => { event.preventDefault(); pick(name); });
    return item;
  }));
}
function pick(name) {
  const input = $('chat-input'); input.value = `/${name} `; input.setSelectionRange(input.value.length, input.value.length);
  suggestIndex = 0; renderSuggest(); controls(); input.focus();
}
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault(); const text = $('chat-input').value, call = summonCall();
  if (answerMode()) {
    if (pending || !text.trim()) return;
    if (await command('help-answer', { id: answering, text })) {
      answering = null; if ($('chat-input').value === text) $('chat-input').value = '';
      placeholder(); controls(); $('chat-input').focus();
    }
    return;
  }
  if (pending || !text.trim() || busy()) return;
  if (await command(call ? 'chat-summon' : 'chat-send', call ? { to: call.to, text: call.text } : { text })) {
    if ($('chat-input').value === text) $('chat-input').value = '';
    renderSuggest(); controls(); $('chat-input').focus();
  }
});
$('chat-input').addEventListener('input', () => { suggestClosed = false; renderSuggest(); controls(); });
$('chat-input').addEventListener('focus', () => { suggestClosed = false; renderSuggest(); });
$('chat-input').addEventListener('blur', () => { suggestClosed = true; renderSuggest(); });
$('chat-input').addEventListener('keydown', event => {
  const items = $('chat-suggest').hidden ? [] : candidates();
  if (items.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault(); suggestIndex = (suggestIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; renderSuggest(); return;
  }
  if (items.length && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !event.isComposing))) { event.preventDefault(); pick(items[suggestIndex]); return; }
  if (items.length && event.key === 'Escape') { event.preventDefault(); suggestClosed = true; renderSuggest(); return; }
  if (answerMode() && event.key === 'Escape') { event.preventDefault(); answering = null; placeholder(); controls(); return; }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); }
});
$('confirm-go').addEventListener('click', () => command('chat-approve', { id: state?.approval?.id, allow: true }));
$('confirm-back').addEventListener('click', () => command('chat-approve', { id: state?.approval?.id, allow: false }));
$('help-answer').addEventListener('click', () => {
  if (!state?.help) return; answering = state.help.id; suggestClosed = true; renderSuggest(); placeholder(); controls(); $('chat-input').focus();
});
$('help-continue').addEventListener('click', () => command('help-continue', { id: state?.help?.id }));
$('help-dismiss').addEventListener('click', () => command('help-dismiss', { id: state?.help?.id }));
for (const [id, type] of [['note-close', 'close-note'], ['note-edit', 'edit'], ['note-inbox', 'inbox'], ['chat-reset', 'chat-reset'], ['chat-stop', 'chat-stop'], ['attachment-remove', 'attachment-remove']]) {
  $(id).addEventListener('click', () => command(type));
}
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) void command('close-note'); });
document.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; });
document.addEventListener('drop', event => event.preventDefault());
if (bridge) { bridge.onState(update); bridge.getState().then(update).catch(error); }
else error(new Error('请通过桌面入口启动文件桌宠'));
controls();
