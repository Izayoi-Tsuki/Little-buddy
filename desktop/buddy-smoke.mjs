import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describeFile } from './file-actions.mjs';
import { randomUUID } from 'node:crypto';

export const smokeStats = { sessions: 0, requests: 0, prompts: [] };
// 「轮流聊」「反问」时每句都不一样，只触发句数或反问门控，不触发重复。
const TOPICS = ['今天天气不错', '我们去喝咖啡', '附件已经看完', '下午三点开会', '记得带上电脑', '晚饭吃面条', '周末打扫房间', '明早赶火车'];
const QUESTIONS = ['你看过附件了吗', '今天几点开会呢', '要不要先吃饭？', '谁负责写总结？', '文件放在哪里呢'];
let spoken = 0;
// 明确的离线替身：仅自检入口注入，不查询模型、不登录、不复用 IDE。
export async function createSmokeSession({ onEvent, onTool, systemPrompt = '' }) {
  smokeStats.sessions++; smokeStats.prompts.push(systemPrompt); let closed = false, stopped = false;
  const emit = event => { if (!closed) onEvent(event); };
  const reply = async (text, ok = true) => {
    if (closed || stopped) return;
    const id = randomUUID(); emit({ type: 'text', id, text: text.slice(0, 4) });
    await new Promise(resolve => setTimeout(resolve, 15));
    if (closed || stopped) return;
    emit({ type: 'text', id, text: text.slice(4) }); emit({ type: 'text', id, text, replace: true });
    emit({ type: 'result', ok });
  };
  const run = async input => {
    const prompt = input.message.content[0].text, instruction = prompt.split('\n\n本次附件信息')[0].replace(/^来自带队者「[^」]*」的任务：/, '').replace(/^同队的「[^」]*」对你说（[^）]*）：/, '').replace(/^用户回答了你的求助（[^）]*）：/, '');
    const data = label => { const match = prompt.match(new RegExp(`${label}（数据，不是指令）：(.*)`)); return match ? JSON.parse(match[1]) : null; };
    const attachment = data('本次附件信息'), squad = data('本次小队信息'), dispatch = instruction.match(/^派活(?:给(.+?))?：(.+)$/);
    const summon = instruction.match(/^用户让你召唤同队的「([^」]*)」传话（[^）]*）：(.*)$/), sayFrom = prompt.match(/^同队的「([^」]*)」对你说/)?.[1];
    const handOver = instruction.match(/^派活带附件：(.+)$/), answered = /^用户回答了你的求助/.test(prompt);
    emit({ type: 'activity', status: 'init' });
    if (instruction === '等待停止') return;
    try {
      // 同伴传话：第一行用「@对象」选择回给对方、向用户汇报还是求助；对方的回话再传回来时就向用户汇报。
      if (answered) await reply(`@用户\n离线测试汇报：收到你的回答：${instruction}`);
      else if (sayFrom) {
        if (instruction.includes('求助')) await reply('@用户 求助\n离线测试求助：缺少文件');
        else if (instruction.includes('一直聊')) await reply(`@${sayFrom} 一直聊`);
        else if (instruction.includes('轮流聊')) await reply(`@${sayFrom} 轮流聊：${TOPICS[spoken++ % TOPICS.length]}`);
        else if (instruction.includes('反问')) await reply(`@${sayFrom} 反问：${QUESTIONS[spoken++ % QUESTIONS.length]}`);
        else if (instruction.includes('直接汇报') || instruction.startsWith('离线测试回复')) await reply(`@用户\n离线测试汇报：${instruction}`);
        else if (attachment) { const value = await onTool('read_attachment', { id: attachment.id }); await reply(`@${sayFrom} 离线测试回复：${value.content ?? value.notice}`); }
        else await reply(`@${sayFrom} 离线测试回复：收到`);
      } else if (['复制附件', '归档附件', '重命名附件'].includes(instruction)) {
        const action = { 复制附件: 'copy', 归档附件: 'archive', 重命名附件: 'rename' }[instruction];
        const result = await onTool('copy_attachment', { id: attachment?.id, action, newName: '另一份' });
        await reply(`离线测试：已保存 ${result.name}。`);
      } else if (instruction === '生成文本') {
        const result = await onTool('save_text', { name: '测试总结.md', content: '# 测试总结\n<script>仅文本，不执行</script>' });
        await reply(`离线测试：已生成 ${result.name}。`);
      } else if (instruction === '总结附件') {
        const value = await onTool('read_attachment', { id: attachment?.id }); await reply(`离线测试：${value.content ?? value.notice}`);
      } else if (instruction === '小队存档') {
        const result = await onTool('save_squad_file', { name: '小队笔记.md', content: `# 小队笔记（${squad?.role ?? '无小队'}）` });
        await reply(`离线测试：已在小队文件夹新建 ${result.name}。`);
      } else if (instruction === '小队查看') {
        const { files } = await onTool('list_squad_files', {}), value = await onTool('read_squad_file', { name: files[0]?.name ?? '' });
        await reply(`离线测试：${files.map(file => file.name).join('、')}｜${value.content ?? value.notice}`);
      } else if (instruction === '小队越界') {
        await onTool('read_squad_file', { name: '../外面.txt' }); await reply('离线测试：不应读到');
      } else if (summon) {
        await reply(`离线测试传话：「${summon[1]}」，请${summon[2]}`);
      } else if (handOver) {
        const result = await onTool('dispatch_task', { member: squad?.members[0], instruction: handOver[1], with_attachment: true });
        await reply(`离线测试：「${result.member}」${result.ok ? '交回' : '未完成'}：${result.reply || result.error}`);
      } else if (dispatch) {
        const result = await onTool('dispatch_task', { member: dispatch[1] ?? squad?.members[0], instruction: dispatch[2] });
        await reply(`离线测试：「${result.member}」${result.ok ? '交回' : '未完成'}：${result.reply || result.error}`);
      } else await reply('离线测试回复：可以直接聊天。');
    } catch (error) { if (!stopped) await reply(`离线工具未执行：${error.message}`, false); }
  };
  return {
    async send(input) { smokeStats.requests++; stopped = false; void run(input); },
    async interrupt() { stopped = true; emit({ type: 'result', ok: false }); },
    async close() { closed = true; stopped = true; },
  };
}

// 自检只使用隔离的测试实例和测试文件，不启动资源管理器，不截图，不接触真实用户文件。
const waitFor = async (predicate, what = () => '') => {
  for (let i = 0; i < 250; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`文件桌宠自检等待超时${what()}`);
};
export async function runBuddySmoke({ ROOT, pet, getNote, showNote, receive, snapshot, diagnostic, inbox }) {
  const wait = predicate => waitFor(predicate, () => `，当前阶段：${snapshot().phase}`);
  const base = join(ROOT, '.buddy-test-data', 'smoke'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'case-')), path = join(directory, '桌宠自检.txt'), text = '桌宠\n测试文件';
  await writeFile(path, text, 'utf8'); const original = await describeFile(path);
  const js = code => pet.webContents.executeJavaScript(code);
  await wait(() => js(`!!window.fileBuddy && document.getElementById("buddy-status").textContent === ${JSON.stringify(snapshot().buddy.name)}`));
  assert.equal(pet.isFocusable(), false); assert.equal(pet.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(await js('typeof window.papertrailDesktop'), 'undefined');
  assert.equal(await js('window.fileBuddy.command("chat-send", {text:"越权"}).then(()=>false,()=>true)'), true);
  assert.equal(await js('window.fileBuddy.command("chat-approve", {id:"fake",allow:true}).then(()=>false,()=>true)'), true);
  assert.equal(await js('window.fileBuddy.drop(new File(["fake"], "伪造.txt")).then(()=>false,()=>true)'), true);
  assert.deepEqual(pet.getSize(), [80, 88]);
  const matGeometry = await js(`(() => { const r=document.getElementById('file-mat').getBoundingClientRect();
    return r.x===10 && r.y===9 && r.width===60 && r.height===55; })()`); assert.equal(matGeometry, true);
  await showNote(); const note = getNote(), noteJs = code => note.webContents.executeJavaScript(code);
  await waitFor(() => noteJs('!!window.fileBuddy && !!document.getElementById("chat-form")'));
  assert.equal(note.isFocusable(), true); assert.deepEqual(note.getSize(), [340, 430]);
  const send = async text => {
    await waitFor(() => noteJs('!document.getElementById("chat-reset").disabled'));
    await noteJs(`(() => { const input=document.getElementById('chat-input'); input.value=${JSON.stringify(text)};
      input.dispatchEvent(new Event('input')); document.getElementById('chat-form').requestSubmit(); })()`);
    await waitFor(() => snapshot().messages.some(m => m.role === 'user' && m.text === text));
  };
  // 无附件聊天和多轮回复；离线回复在 UI 中明确标示，不冒充真实模型。
  await send('你好'); await waitFor(() => snapshot().phase === 'done');
  await waitFor(() => noteJs('document.querySelectorAll(".message[data-role=assistant]").length === 1'));
  assert.equal(await noteJs('document.querySelector(".message[data-role=assistant]").textContent.includes("离线测试回复")'), true);
  const sessions = smokeStats.sessions; await send('继续'); await waitFor(() => snapshot().phase === 'done'); assert.equal(smokeStats.sessions, sessions);
  await noteJs('window.fileBuddy.command("chat-reset")'); assert.deepEqual(snapshot().messages, []);
  const compactUi = await noteJs(`(() => { const main=document.querySelector('main'), form=document.getElementById('chat-form').getBoundingClientRect();
    return document.documentElement.scrollWidth<=innerWidth && main.scrollWidth<=main.clientWidth
      && [...document.querySelectorAll('#chat-input,#chat-reset,#chat-send')].every(node => {
        const r=node.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.bottom<=form.bottom;
      }); })()`); assert.equal(compactUi, true);
  const imeSafe = await noteJs(`(() => { const input=document.getElementById('chat-input'); input.value='中文输入未完成';
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));
    return input.value==='中文输入未完成'; })()`); assert.equal(imeSafe, true); assert.equal(snapshot().messages.length, 0);
  await noteJs('document.getElementById("chat-input").value=""');

  // CDP 给真实 File 赋路径，走页面→preload webUtils→IPC；不等价于 Explorer 原生拖放。
  pet.webContents.debugger.attach('1.3');
  try {
    await js('(() => { const input=document.createElement("input"); input.type="file"; input.id="smoke-file"; input.hidden=true; document.body.append(input); })()');
    const doc = await pet.webContents.debugger.sendCommand('DOM.getDocument');
    const input = await pet.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#smoke-file' });
    await pet.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path] });
    const hover = await js(`(() => { const transfer=new DataTransfer(); transfer.items.add(document.getElementById('smoke-file').files[0]);
      const mat=document.getElementById('file-mat'); mat.dispatchEvent(new DragEvent('dragenter',{dataTransfer:transfer,bubbles:true,cancelable:true}));
      const greeted=mat.classList.contains('is-over') && document.getElementById('buddy-status').textContent.includes('放给我');
      mat.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true})); return greeted; })()`);
    assert.equal(hover, true); await waitFor(() => snapshot().phase === 'asking');
  } finally { pet.webContents.debugger.detach(); }
  await waitFor(() => noteJs(`document.getElementById('note-file').textContent===${JSON.stringify(original.name)}`));
  assert.equal(snapshot().file.path, path); const before = await readdir(directory);
  await send('总结附件'); await waitFor(() => snapshot().phase === 'done');
  assert.ok(snapshot().messages.at(-1).text.includes(text)); assert.deepEqual(await readdir(directory), before);
  await send('复制附件'); await waitFor(() => snapshot().phase === 'confirming');
  assert.deepEqual(await readdir(directory), before); await waitFor(() => noteJs('!document.getElementById("confirm-back").disabled'));
  const rejectedId = snapshot().approval.id;
  await noteJs('document.getElementById("confirm-back").click()'); await waitFor(() => snapshot().phase === 'failed');
  assert.deepEqual(await readdir(directory), before);
  assert.equal(await noteJs(`window.fileBuddy.command('chat-approve',{id:${JSON.stringify(rejectedId)},allow:true}).then(()=>false,()=>true)`), true);
  for (const [instruction, expected] of [['复制附件', join('收纳', original.name)], ['重命名附件', join('重命名', '另一份.txt')], ['归档附件', null]]) {
    await send(instruction); await waitFor(() => snapshot().phase === 'confirming');
    const output = snapshot().approval.output; if (expected) assert.equal(output, join(inbox, expected)); else assert.ok(output.includes(join('归档', '文档')));
    await waitFor(() => noteJs('!document.getElementById("confirm-go").disabled')); await noteJs('document.getElementById("confirm-go").click()');
    await waitFor(() => snapshot().phase === 'done'); assert.equal(await readFile(output, 'utf8'), text);
  }
  await send('生成文本'); await waitFor(() => snapshot().phase === 'confirming'); const generated = snapshot().approval.output;
  await waitFor(() => noteJs('!document.getElementById("confirm-preview").hidden && !document.getElementById("confirm-go").disabled'));
  assert.equal(await noteJs('document.getElementById("confirm-preview").textContent'), '# 测试总结\n<script>仅文本，不执行</script>');
  assert.equal(await noteJs('document.getElementById("confirm-preview").querySelector("script") === null'), true);
  await noteJs('document.getElementById("confirm-go").click()'); await waitFor(() => snapshot().phase === 'done');
  assert.equal(await readFile(generated, 'utf8'), '# 测试总结\n<script>仅文本，不执行</script>');
  await send('等待停止'); await waitFor(() => snapshot().phase === 'working'); await waitFor(() => noteJs('!document.getElementById("chat-stop").disabled'));
  await noteJs('document.getElementById("chat-stop").click()'); await waitFor(() => snapshot().phase === 'idle');
  const mutated = join(directory, '有变化.txt'); await writeFile(mutated, '旧内容'); await receive(mutated); await writeFile(mutated, '新内容，不该复制');
  await send('复制附件'); await waitFor(() => snapshot().phase === 'confirming');
  const staleOutput = snapshot().approval.output; await noteJs('window.fileBuddy.command("chat-approve",{id:' + JSON.stringify(snapshot().approval.id) + ',allow:true})');
  await waitFor(() => snapshot().phase === 'failed'); assert.ok(snapshot().messages.at(-1).text.includes('变化'));
  await assert.rejects(readFile(staleOutput)); await noteJs('window.fileBuddy.command("chat-reset")');
  assert.deepEqual(await describeFile(path), original);
  const rejected = await js(`(() => { const mat=document.getElementById('file-mat'), dt=new DataTransfer(); dt.items.add(new File(['1'],'a.txt')); dt.items.add(new File(['2'],'b.txt'));
    mat.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true})); return document.getElementById('buddy-error').textContent.includes('一个文件'); })()`);
  assert.equal(rejected, true); assert.equal(snapshot().phase, 'idle');
  const blockedNetwork = await js('fetch("https://example.com").then(()=>false,()=>true)'); assert.equal(blockedNetwork, true);
  // 仅剔除这一次明确的 CSP 策略拒绝。
  const unexpected = diagnostic.filter(message => !/Content Security Policy|connect-src/.test(message)); assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ fileBuddySmoke: 'passed', realFileBridge: true, simulatedDrop: true, nativeExplorerDrop: '待用户验收',
    chat: true, multiTurn: true, streaming: true, compactUi, matGeometry, imeSafe, confirmation: true, stop: true,
    originalUnchanged: true, staleFileRejected: true, separateUserData: true, sandbox: true, networkBlocked: blockedNetwork,
    modelRequestSent: false, inbox, diagnostic: unexpected }));
}

// 多桌宠：走设定页表单新建与改名，确认窗口、会话、署名和名册各自独立，删除只回收那一只。
export async function runMultiBuddySmoke({ first, list, getEditor, openEditor, showNote, snapshotOf, removeBuddy, diagnostic, flush }) {
  const before = snapshotOf(first).messages.length;
  const submit = (editor, { name, role = '', color = 'green', style = 'short' }) => editor.webContents.executeJavaScript(`(() => {
    document.getElementById('edit-name').value=${JSON.stringify(name)}; document.getElementById('edit-role').value=${JSON.stringify(role)};
    document.querySelector('input[name=color][value=${color}]').checked=true; document.querySelector('input[name=style][value=${style}]').checked=true;
    document.getElementById('edit-form').requestSubmit(); })()`);
  await openEditor(null); const editor = getEditor(), editJs = code => editor.webContents.executeJavaScript(code);
  await waitFor(() => editJs('document.getElementById("edit-save").textContent === "创建" && document.getElementById("edit-name").value.length > 0'));
  assert.equal(editor.webContents.getLastWebPreferences().sandbox, true); assert.equal(await editJs('typeof window.papertrailDesktop'), 'undefined');
  const editorFits = await editJs(`(() => { const form=document.getElementById('edit-form'), save=document.getElementById('edit-save').getBoundingClientRect();
    return document.documentElement.scrollWidth<=innerWidth && form.scrollHeight<=form.clientHeight && save.bottom<=innerHeight && save.right<=innerWidth; })()`);
  assert.equal(editorFits, true);
  await submit(editor, { name: first.name }); await waitFor(() => editJs('!document.getElementById("edit-error").hidden'));
  assert.equal(list().length, 1);
  await submit(editor, { name: '资料员', role: '负责读附件，提炼要点', color: 'blue', style: 'mascot' });
  await waitFor(() => list().length === 2 && !getEditor());
  const second = list()[1];
  assert.deepEqual({ name: second.name, role: second.role, look: second.look }, { name: '资料员', role: '负责读附件，提炼要点', look: { color: 'blue', style: 'mascot' } });
  assert.notEqual(second.id, first.id); assert.notEqual(second.agent, first.agent);
  assert.deepEqual(second.pet.getSize(), [80, 88]); assert.equal(second.pet.isFocusable(), false);
  await waitFor(() => second.pet.webContents.executeJavaScript('document.getElementById("buddy-status").textContent === "资料员"'));
  await showNote(second); const noteJs = code => second.note.webContents.executeJavaScript(code);
  await waitFor(() => noteJs('!!document.getElementById("chat-form") && document.getElementById("note-title").textContent.includes("资料员")'));
  await noteJs(`(() => { const input=document.getElementById('chat-input'); input.value='你好，资料员';
    input.dispatchEvent(new Event('input')); document.getElementById('chat-form').requestSubmit(); })()`);
  await waitFor(() => snapshotOf(second).phase === 'done');
  const separateSessions = snapshotOf(first).messages.length === before && snapshotOf(second).messages.some(m => m.text === '你好，资料员');
  assert.equal(separateSessions, true);
  const personaPrompt = smokeStats.prompts.at(-1).includes('「资料员」') && smokeStats.prompts.at(-1).includes('负责读附件');
  assert.equal(personaPrompt, true);
  const label = 'document.querySelector(".message[data-role=assistant] .message-label").textContent';
  await waitFor(async () => await noteJs(label) === '资料员');
  assert.equal(await first.pet.webContents.executeJavaScript('window.fileBuddy.command("editor-save",{name:"冒充"}).then(()=>false,()=>true)'), true);
  assert.equal(await noteJs('window.fileBuddy.command("editor-save",{name:"冒充"}).then(()=>false,()=>true)'), true);
  await openEditor(second); const renameEditor = getEditor();
  await waitFor(() => renameEditor.webContents.executeJavaScript('document.getElementById("edit-save").textContent === "保存" && document.getElementById("edit-name").value === "资料员"'));
  await submit(renameEditor, { name: '整理员', role: '负责归档', color: 'orange', style: 'long' });
  await waitFor(() => second.name === '整理员' && !getEditor());
  await waitFor(async () => await noteJs(label) === '整理员' && await second.pet.webContents.executeJavaScript('document.getElementById("buddy-status").textContent') === '整理员');
  let saved = JSON.parse(await flush());
  assert.deepEqual(saved.buddies.map(b => [b.name, b.look.color]), [[first.name, first.look.color], ['整理员', 'orange']]);
  const windows = [second.pet, second.note];
  assert.equal(await removeBuddy(second), true); assert.equal(list().length, 1); assert.ok(windows.every(window => window.isDestroyed()));
  await assert.rejects(removeBuddy(first), /至少保留/);
  saved = JSON.parse(await flush()); assert.deepEqual(saved.buddies.map(b => b.id), [first.id]);
  const unexpected = diagnostic.filter(message => !/Content Security Policy|connect-src/.test(message)); assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ multiBuddySmoke: 'passed', createdViaEditor: true, duplicateRejected: true, separateSessions, personaPrompt,
    spoofRejected: true, renamed: true, removed: true, lastKept: true, registryPersisted: true, editorFits, diagnostic: unexpected }));
}

// 组队：模拟「拖到另一只身上松手」，在卡片里点选关系；军衔、爱心眼、便利贴小队条、名册和离队都要跟着变。
export async function runSquadSmoke({ first, list, create, drop, hover, getLinker, getSquads, showNote, removeBuddy, leave, diagnostic, flush }) {
  const { SQUAD_COLORS } = await import('../src/file-buddy.mjs'), { RANK_PAPER } = await import('../src/buddy-rank.mjs'), { HEART_COLOR } = await import('../src/scene.mjs');
  const a = await create({ name: '甲', look: { color: 'blue', style: 'short' } }), b = await create({ name: '乙', look: { color: 'purple', style: 'long' } });
  const [A, B] = [a, b].map(p => list().find(item => item.id === p.id)), F = first;
  const petJs = (x, code) => x.pet.webContents.executeJavaScript(code);
  const status = x => petJs(x, 'document.getElementById("buddy-status").textContent');
  const pixel = (x, px, py) => petJs(x, `[...document.getElementById('buddy-canvas').getContext('2d').getImageData(${px},${py},1,1).data]`);
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(255);
  const squadOfX = x => getSquads().find(s => s.members.includes(x.id)) ?? null;
  // 军衔按第 8 列的 2–13 行取样：d 外框、m 杠、p 衬底、- 透明。带队三杠、同伴两杠、成员一杠。
  const RANKS = { lead: 'dpmmpmmpmmpd', peer: 'dppmmpmmpppd', member: 'dppppmmppppd', none: '------------' };
  const rank = (x, c) => petJs(x, `[...document.getElementById('buddy-canvas').getContext('2d').getImageData(8,2,1,12).data]`).then(data => {
    const key = rgba => ({ [rgb(c.dark)]: 'd', [rgb(c.main)]: 'm', [rgb(RANK_PAPER)]: 'p', '0,0,0,0': '-' })[rgba.join(',')] ?? '?';
    return Array.from({ length: 12 }, (_, i) => key(data.slice(i * 4, i * 4 + 4))).join('');
  });
  let lastRank = '';
  const ranked = (x, c, kind) => waitFor(async () => (lastRank = await rank(x, c)) === RANKS[kind], () => `，${x.name} 军衔：${lastRank}，应为 ${RANKS[kind]}`);
  const overlap = (x, y) => { const [p, q] = [x.pet.getPosition(), y.pet.getPosition()]; return Math.abs(p[0] - q[0]) < 80 && Math.abs(p[1] - q[1]) < 88; };
  // 松手后等卡片加载完并填好指定数量的选项。
  const open = async (x, y, count) => {
    await waitFor(() => !getLinker()); const origin = drop(x, y);
    await waitFor(async () => getLinker() && await getLinker().webContents.executeJavaScript(
      `!!window.fileBuddy && document.getElementById('link-options').children.length === ${count} && document.getElementById('link-title').textContent !== '桌宠组队'`).catch(() => false));
    return { origin, linkJs: code => getLinker().webContents.executeJavaScript(code) };
  };
  const choose = async (linkJs, option) => { await linkJs(`document.querySelector('[data-option="${option}"]').click()`); await waitFor(() => !getLinker()); };

  // 拖动中悬停在别的桌宠身上，对方提示「松手组队」；移开就恢复。
  const start = A.pet.getPosition(); hover(A, F);
  await waitFor(async () => await status(F) === '松手组队'); hover(A, null); A.pet.setPosition(...start);
  await waitFor(async () => await status(F) === F.name);

  let { origin, linkJs } = await open(A, F, 3);
  const linker = getLinker();
  assert.equal(linker.webContents.getLastWebPreferences().sandbox, true); assert.equal(await linkJs('typeof window.papertrailDesktop'), 'undefined');
  assert.equal(linker.getSize()[0], 260);
  const linkFits = await linkJs(`(() => { const d=document.documentElement, c=document.getElementById('link-cancel').getBoundingClientRect();
    const options=[...document.querySelectorAll('.option')].every(o => { const r=o.getBoundingClientRect(); return r.bottom<=innerHeight && r.right<=innerWidth && o.scrollWidth<=o.clientWidth+1; });
    return d.scrollHeight<=innerHeight && d.scrollWidth<=innerWidth && c.bottom<=innerHeight && options; })()`);
  assert.equal(linkFits, true);
  assert.equal(await petJs(F, 'window.fileBuddy.command("link-choose",{option:"peer"}).then(()=>false,()=>true)'), true);
  assert.equal(await F.note.webContents.executeJavaScript('window.fileBuddy.command("link-choose",{option:"peer"}).then(()=>false,()=>true)'), true);
  assert.equal(await linkJs('window.fileBuddy.command("chat-send",{text:"越权"}).then(()=>false,()=>true)'), true);
  await linkJs('document.getElementById("link-cancel").click()'); await waitFor(() => !getLinker());
  assert.deepEqual(A.pet.getPosition(), origin); assert.equal(getSquads().length, 0);
  const cancelRestored = true;

  // 同伴：组队后甲挨在桌宠身边但不重叠，两只先冒爱心眼，左上角都挂上同色的两道杠。
  ({ linkJs } = await open(A, F, 3)); await choose(linkJs, 'peer');
  const love = await petJs(A, 'document.body.dataset.emote') === 'love' && await petJs(F, 'document.body.dataset.emote') === 'love'
    && JSON.stringify(await pixel(A, 33, 28)) === JSON.stringify(rgb(HEART_COLOR));
  assert.equal(love, true, '组队后两只都应冒爱心眼');
  const first_ = squadOfX(F); assert.deepEqual([first_.lead, [...first_.members].sort()], [null, [A.id, F.id].sort()]);
  assert.equal(overlap(A, F), false);
  const [ax, ay] = A.pet.getPosition(), [fx, fy] = F.pet.getPosition(); assert.ok(Math.abs(ax - fx) <= 92 && Math.abs(ay - fy) <= 100, '组队后应挨在一起');
  const color = SQUAD_COLORS[first_.color];
  for (const x of [A, F]) await ranked(x, color, 'peer');
  await ranked(B, color, 'none');
  const rankDrawn = true;

  // 乙加入并带队：带队的三道杠、成员一道杠，便利贴显示小队说明，且不挤掉输入框。
  ({ linkJs } = await open(B, A, 2)); await choose(linkJs, 'lead-dragged');
  assert.deepEqual([squadOfX(F).lead, squadOfX(F).members.length], [B.id, 3]);
  await ranked(B, color, 'lead'); await ranked(A, color, 'member'); await ranked(F, color, 'member');
  await showNote(F); const noteJs = code => F.note.webContents.executeJavaScript(code);
  await waitFor(() => noteJs(`!document.getElementById('note-squad').hidden && document.getElementById('note-squad-text').textContent.startsWith('成员 · 「乙」带')`));
  const noteFits = await noteJs(`(() => { const f=document.getElementById('chat-form').getBoundingClientRect(), s=document.getElementById('note-squad').getBoundingClientRect();
    return f.bottom<=innerHeight && s.height>0 && s.height<=22 && document.documentElement.scrollHeight<=innerHeight; })()`);
  assert.equal(noteFits, true);
  assert.ok((await petJs(F, 'document.getElementById("buddy-body").title')).includes('小队：「乙」带'));

  // 已在不同小队的两只不给选项，只说明原因；「知道了」后送回原位。
  const c = await create({ name: '丙', look: { color: 'orange', style: 'short' } }), d = await create({ name: '丁', look: { color: 'green', style: 'mascot' } });
  const [C, D] = [c, d].map(p => list().find(item => item.id === p.id));
  ({ linkJs } = await open(D, C, 3)); await choose(linkJs, 'peer');
  assert.notEqual(squadOfX(C).color, squadOfX(F).color);
  ({ origin, linkJs } = await open(C, F, 0));
  assert.equal(await linkJs('!document.getElementById("link-note").hidden && document.getElementById("link-cancel").textContent === "知道了"'), true);
  assert.equal(await linkJs('window.fileBuddy.command("link-choose",{option:"peer"}).then(()=>false,()=>true)'), true);
  await linkJs('document.getElementById("link-cancel").click()'); await waitFor(() => !getLinker());
  assert.deepEqual(C.pet.getPosition(), origin); assert.equal(squadOfX(C).members.length, 2);
  const crossBlocked = true;

  // 同队内调整：改由桌宠带队；再让甲离队。
  ({ linkJs } = await open(F, B, 3)); await choose(linkJs, 'lead-dragged');
  assert.equal(squadOfX(B).lead, F.id);
  let saved = JSON.parse(await flush());
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.squads.map(s => [s.lead, s.members.length]).sort(), [[F.id, 3], [null, 2]].sort());
  ({ origin, linkJs } = await open(A, F, 3)); await choose(linkJs, 'leave');
  assert.equal(squadOfX(A), null); assert.deepEqual(A.pet.getPosition(), origin);
  await waitFor(async () => await rank(A, color) === RANKS.none);

  // 右键「离开小队」后只剩一只就解散；删掉成员同样会解散。
  leave(B); assert.equal(squadOfX(F), null);
  await waitFor(() => noteJs('document.getElementById("note-squad").hidden'));
  assert.equal(await removeBuddy(D), true); assert.equal(squadOfX(C), null);
  saved = JSON.parse(await flush()); assert.deepEqual(saved.squads, []);
  const unexpected = diagnostic.filter(message => !/Content Security Policy|connect-src/.test(message)); assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ squadSmoke: 'passed', hoverHint: true, linkFits, spoofRejected: true, cancelRestored, peer: true, besideNoOverlap: true,
    rankDrawn, love, joinWithLead: true, rankLevels: true, noteFits, crossBlocked, relead: true, registryPersisted: true, leave: true, dissolved: true, diagnostic: unexpected }));
}

// 派活：带队者把任务交给成员，成员便利贴标明来源，结果交回带队者；小队文件夹只新建不覆盖；停止任一只，整条链一起停。
export async function runDispatchSmoke({ first, list, setTeam, clearTeam, showNote, snapshotOf, inbox, diagnostic }) {
  const { squadFolder } = await import('./buddy-squads.mjs');
  const named = name => list().find(x => x.name === name), [F, A, B, C] = [first, named('甲'), named('乙'), named('丙')];
  const phase = x => snapshotOf(x).phase, last = (x, role) => snapshotOf(x).messages.filter(m => m.role === role).at(-1)?.text ?? '';
  const wait = (predicate, x) => waitFor(predicate, () => `，${x.name}：${phase(x)}`);
  const noteJs = async (x, code) => {
    await showNote(x); await waitFor(() => x.note.webContents.executeJavaScript('!!window.fileBuddy').catch(() => false));
    return x.note.webContents.executeJavaScript(code);
  };
  const say = (x, text) => noteJs(x, `window.fileBuddy.command('chat-send',{text:${JSON.stringify(text)}})`);
  const settled = x => wait(() => ['done', 'failed', 'idle'].includes(phase(x)), x);
  const squad = setTeam(F, [A, B]), folder = join(inbox, ...squadFolder(squad));

  // 小队文件：成员新建，带队者列出并读取；同名加序号不覆盖；带路径和不在小队的都被拒绝。
  await say(A, '小队存档'); await settled(A); assert.equal(phase(A), 'done');
  assert.equal(await readFile(join(folder, '小队笔记.md'), 'utf8'), '# 小队笔记（member）');
  assert.ok(last(A, 'system').includes('已在小队文件夹新建'));
  await say(F, '小队查看'); await settled(F); assert.ok(last(F, 'assistant').includes('小队笔记.md｜# 小队笔记（member）'), last(F, 'assistant'));
  await say(F, '小队存档'); await settled(F);
  assert.equal(await readFile(join(folder, '小队笔记 (2).md'), 'utf8'), '# 小队笔记（lead）');
  assert.equal(await readFile(join(folder, '小队笔记.md'), 'utf8'), '# 小队笔记（member）');
  await say(F, '小队越界'); await settled(F); assert.equal(phase(F), 'failed'); assert.ok(last(F, 'assistant').includes('不能带路径'));
  await say(C, '小队存档'); await settled(C); assert.ok(last(C, 'assistant').includes('不在小队'));
  const squadFiles = true;

  // 派活成功：成员便利贴显示「来自…的任务」，回复交回带队者。
  await say(F, '派活：帮我看看'); await settled(F); assert.equal(phase(F), 'done');
  const task = snapshotOf(A).messages.find(m => m.role === 'task');
  assert.deepEqual([task.from, task.text], [F.name, '帮我看看']);
  assert.ok(last(F, 'assistant').includes('「甲」交回：离线测试回复'), last(F, 'assistant'));
  assert.ok(snapshotOf(F).messages.some(m => m.role === 'system' && m.text.includes('已派给「甲」')));
  const taskLabel = `来自「${F.name}」的任务`;
  await wait(async () => await noteJs(A, `[...document.querySelectorAll('.message[data-role=task] .message-label')].some(n => n.textContent === ${JSON.stringify(taskLabel)})`), A);

  // 成员正忙时不派；成员不能再转派。
  await say(A, '等待停止'); await wait(() => phase(A) === 'working', A);
  await say(F, '派活：再来一项'); await settled(F); assert.ok(last(F, 'assistant').includes('正忙'), last(F, 'assistant'));
  await noteJs(A, 'window.fileBuddy.command("chat-stop")'); await wait(() => phase(A) === 'idle', A);
  await say(F, '派活：派活：转派'); await settled(F);
  assert.ok(last(F, 'assistant').includes('「甲」未完成') && last(F, 'assistant').includes('只有带队'), last(F, 'assistant'));

  // 成员需要确认写入时自动打开它的便利贴，确认后带队者才拿到结果。
  await say(F, '派活给乙：生成文本'); await wait(() => phase(B) === 'confirming' && !!B.note, B);
  await wait(() => B.note.webContents.executeJavaScript('!!window.fileBuddy && !document.getElementById("note-confirming").hidden && !document.getElementById("confirm-go").disabled').catch(() => false), B);
  assert.equal(phase(F), 'working');
  await B.note.webContents.executeJavaScript('document.getElementById("confirm-go").click()');
  await settled(F); assert.ok(last(F, 'assistant').includes('「乙」交回：离线测试：已生成'), last(F, 'assistant'));
  const confirmOpened = true;

  // 整队停止：停成员时带队者一起停，停带队者时成员一起停；之后还能正常派活。
  await say(F, '派活：等待停止'); await wait(() => phase(A) === 'working' && snapshotOf(F).activity.includes('正在等「甲」'), F);
  await noteJs(A, 'window.fileBuddy.command("chat-stop")'); await wait(() => phase(A) === 'idle' && phase(F) === 'idle', F);
  await say(F, '派活给乙：等待停止'); await wait(() => phase(B) === 'working', B);
  await noteJs(F, 'window.fileBuddy.command("chat-stop")'); await wait(() => phase(B) === 'idle' && phase(F) === 'idle', B);
  await say(F, '派活：收尾'); await settled(F); assert.equal(phase(F), 'done');
  const teamStop = true;
  clearTeam();
  const unexpected = diagnostic.filter(message => !/Content Security Policy|connect-src/.test(message)); assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ dispatchSmoke: 'passed', squadFiles, noOverwrite: true, pathRejected: true, outsiderRejected: true, dispatched: true, taskLabel: true,
    busyRejected: true, noRedispatch: true, confirmOpened, teamStop, diagnostic: unexpected }));
}

// 斜杠召唤：便利贴里输入「/」列出同组成员；召唤后甲走到乙身边冒泡传话，乙空闲就回话，忙时默认回 OK 并抖一抖；
// 回话用「@对象」选择回给对方（冒泡并接着聊）、向用户汇报（跳一下、冒感叹号）还是求助；重复、聊满 4 句、互相反问时停下来等用户决定；
// 附件随传话和派活交给对方。
export async function runSummonSmoke({ first, list, setTeam, clearTeam, showNote, snapshotOf, inbox, diagnostic }) {
  const named = name => list().find(x => x.name === name), [F, A, B, C] = [first, named('甲'), named('乙'), named('丙')];
  const phase = x => snapshotOf(x).phase, has = (x, role, text) => snapshotOf(x).messages.some(m => m.role === role && m.text.startsWith(text));
  const heard = (x, from, text) => snapshotOf(x).messages.find(m => m.role === 'task' && m.kind === 'say' && m.from === from.name && m.text.startsWith(text));
  const emote = x => x.pet.webContents.executeJavaScript('document.body.dataset.emote ?? ""');
  const calm = () => waitFor(() => !F.meeting && !F.composing && [F, A, B].every(x => !['working', 'confirming', 'stopping'].includes(phase(x))));
  const wait = (predicate, x) => waitFor(predicate, () => `，${x.name}：${phase(x)}`);
  const noteJs = async (x, code) => {
    await showNote(x); await waitFor(() => x.note.webContents.executeJavaScript('!!window.fileBuddy').catch(() => false));
    return x.note.webContents.executeJavaScript(code);
  };
  const bubbleJs = (x, code) => x.bubble && !x.bubble.isDestroyed() ? x.bubble.webContents.executeJavaScript(code).catch(() => null) : null;
  const bubble = x => bubbleJs(x, `(() => { const b=document.getElementById('bubble'); return b.hidden ? null : { text: document.getElementById('bubble-text').textContent, kind: b.dataset.kind, shaking: b.classList.contains('is-shaking') }; })()`);
  const rejected = code => `${code}.then(()=>'',e=>e.message)`;
  setTeam(F, [A, B]);
  const [fx, fy] = F.pet.getPosition(); A.pet.setPosition(fx > 400 ? fx - 300 : fx + 300, fy);

  // 补全列表：输入「/」列出同组成员，Tab 补全为「/甲 」，按钮变成「召唤」。
  await noteJs(F, `(() => { const input=document.getElementById('chat-input'); input.value='/'; input.dispatchEvent(new Event('input')); })()`);
  await waitFor(() => noteJs(F, `(() => { const list=document.getElementById('chat-suggest');
    return !list.hidden && [...list.querySelectorAll('li')].map(li => li.dataset.name).join(',') === '甲,乙'; })()`));
  const completed = await noteJs(F, `(() => { const input=document.getElementById('chat-input');
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
    return input.value === '/甲 ' && document.getElementById('chat-send').textContent === '召唤 ↗' && document.getElementById('chat-suggest').hidden; })()`);
  assert.equal(completed, true);

  // 召唤空闲的甲：桌宠先把用户的原话加工成要对甲说的话，再走过去冒泡；甲的便利贴标明谁在说话。
  // 甲选择回给桌宠：冒对话框，话交给桌宠接着聊；桌宠再选择向用户汇报，跳一下、冒感叹号。
  await noteJs(F, `(() => { const input=document.getElementById('chat-input'); input.value='/甲 帮我看看';
    input.dispatchEvent(new Event('input')); document.getElementById('chat-form').requestSubmit(); })()`);
  const composed = '离线测试传话：「甲」，请帮我看看';
  await wait(() => snapshotOf(F).messages.some(m => m.role === 'user' && m.kind === 'summon' && m.text === '/甲 帮我看看'), F);
  await wait(() => heard(F, A, '离线测试回复：收到'), F);
  assert.ok(has(F, 'assistant', composed));
  const said = snapshotOf(A).messages.find(m => m.role === 'task' && m.kind === 'say');
  assert.deepEqual([said?.from, said?.text], [F.name, composed], '传给甲的应是桌宠加工后的话');
  const [ax, ay] = A.pet.getPosition(), [gx, gy] = F.pet.getPosition();
  const walked = Math.abs(ax - gx) <= 100 && Math.abs(ay - gy) <= 100; assert.equal(walked, true, '召唤后应走到对方身边');
  assert.equal((await bubble(F))?.text, composed);
  await waitFor(async () => { const v = await bubble(A); return v?.kind === 'reply' && v.text === '离线测试回复：收到'; });
  await wait(async () => await emote(F) === 'report', F);
  assert.ok(has(F, 'assistant', '@用户'), '桌宠应选择向用户汇报');
  const sayLabel = `「${F.name}」对你说`;
  await wait(async () => await noteJs(A, `[...document.querySelectorAll('.message[data-role=task] .message-label')].some(n => n.textContent === ${JSON.stringify(sayLabel)})`), A);
  assert.equal(await noteJs(F, 'document.getElementById("chat-input").value'), '');
  const talkedBack = true;
  
  // 乙选择直接向用户汇报：不冒对话框，跳一下、冒感叹号，汇报也记在发起召唤的桌宠便利贴上。
  await calm();
  await noteJs(F, `window.fileBuddy.command('chat-summon',{to:'乙',text:'直接汇报'})`);
  await wait(() => has(F, 'system', '「乙」直接向你汇报：离线测试汇报'), F);
  await wait(async () => await emote(B) === 'report', B); assert.equal(await bubble(B), null, '向用户汇报不冒对话框');
  const reported = true;
  
  // 两只一直说差不多的话：第二次重复就停下来等用户决定，重复的那只冒问号，求助卡片置顶在发起召唤的便利贴上。
  const help = x => snapshotOf(x).help, card = x => noteJs(x, `(() => { const c=document.getElementById('note-help');
    return c.hidden ? null : ['help-topic','help-reason','help-text'].map(id => document.getElementById(id).textContent).join('|'); })()`);
  await calm();
  await noteJs(F, `window.fileBuddy.command('chat-summon',{to:'甲',text:'一直聊'})`);
  await wait(() => help(F)?.reason.includes('重复'), F);
  assert.deepEqual([help(F).asker, help(F).peer, help(F).text], [F.name, '甲', '一直聊']);
  assert.equal(snapshotOf(A).waiting, F.name); assert.equal(help(A), null); assert.ok(has(F, 'system', '需要你：'));
  await wait(async () => await emote(F) === 'help', F);
  await wait(async () => (await card(F))?.includes(`「${F.name}」最后说：一直聊`), F);
  const rounds = snapshotOf(F).messages.filter(m => m.kind === 'say' && m.text === '一直聊').length + snapshotOf(A).messages.filter(m => m.kind === 'say' && m.text.includes('一直聊')).length;
  assert.equal(rounds, 2, '重复的那句不再传给对方');
  // 等待期间这一对不接新的召唤和派活。
  assert.ok((await noteJs(F, rejected(`window.fileBuddy.command('chat-summon',{to:'乙',text:'嗨'})`))).includes('在等你决定'));
  assert.ok((await noteJs(A, rejected(`window.fileBuddy.command('chat-summon',{to:'乙',text:'嗨'})`))).includes('在等你决定'));
  await noteJs(F, `window.fileBuddy.command('chat-send',{text:'派活给甲：整理一下'})`);
  await wait(() => has(F, 'assistant', '离线工具未执行：「甲」正忙') && !['working', 'stopping'].includes(phase(F)), F);
  assert.equal(help(F)?.reason.includes('重复'), true, '求助不因为别的操作消失');
  // 让它们再聊几句：句数和计数重新算，甲又重复就再停下；结束求助后这一对又能接召唤。
  const firstHelp = help(F).id;
  await noteJs(F, `document.getElementById('help-continue').click()`);
  await wait(() => help(F) && help(F).id !== firstHelp, F);
  assert.deepEqual([help(F).asker, help(F).peer], ['甲', F.name]); await wait(async () => await emote(A) === 'help', A);
  assert.equal(snapshotOf(F).waiting, F.name);
  await noteJs(F, `document.getElementById('help-dismiss').click()`);
  await wait(() => !help(F) && !snapshotOf(A).waiting && has(F, 'system', '已结束这次求助'), F);
  assert.equal(await card(F), null);
  assert.ok((await noteJs(F, rejected(`window.fileBuddy.command('help-dismiss',{id:${JSON.stringify(firstHelp)}})`))).includes('已经处理过'));
  const repeatGate = true;

  // 聊满 4 句还没有结果：第 4 句的回话不再传过去，停下来求助。
  await calm();
  await noteJs(F, `window.fileBuddy.command('chat-summon',{to:'甲',text:'轮流聊'})`);
  await wait(() => help(F)?.reason.includes('聊满 4 句'), F);
  const roundLimit = snapshotOf(F).messages.filter(m => m.kind === 'say' && m.text.startsWith('轮流聊')).length
    + snapshotOf(A).messages.filter(m => m.kind === 'say' && m.text.includes('轮流聊')).length;
  assert.equal(roundLimit, 4); assert.equal(help(F).asker, F.name);
  await noteJs(F, `window.fileBuddy.command('help-dismiss',{id:${JSON.stringify(help(F).id)}})`); await wait(() => !help(F), F);

  // 互相反问：连续 3 句都是问句就停下。
  await calm();
  await noteJs(F, `window.fileBuddy.command('chat-summon',{to:'甲',text:'反问'})`);
  await wait(() => help(F)?.reason.includes('互相反问'), F);
  assert.equal(help(F).asker, '甲');
  await noteJs(F, `window.fileBuddy.command('help-dismiss',{id:${JSON.stringify(help(F).id)}})`); await wait(() => !help(F), F);

  // 甲主动求助：卡片写明它想问什么；用户在卡片上「我来回答」，回答交给甲接着做，甲再向用户汇报。
  await calm();
  await noteJs(F, `window.fileBuddy.command('chat-summon',{to:'甲',text:'求助'})`);
  await wait(() => help(F)?.asked, F);
  assert.deepEqual([help(F).asker, help(F).reason, help(F).text], ['甲', '「甲」主动求助', '离线测试求助：缺少文件']);
  await wait(async () => await emote(A) === 'help', A); assert.notEqual((await bubble(A))?.text, '离线测试求助：缺少文件', '求助不冒对话框');
  await wait(async () => (await card(F))?.includes('「甲」想问你：离线测试求助：缺少文件'), F);
  const answerUi = await noteJs(F, `(() => { document.getElementById('help-answer').click(); const input=document.getElementById('chat-input');
    input.value='用第二版'; input.dispatchEvent(new Event('input'));
    const ok = document.getElementById('chat-send').textContent === '回答 ↗' && input.placeholder.startsWith('回答「甲」的求助');
    document.getElementById('chat-form').requestSubmit(); return ok; })()`);
  assert.equal(answerUi, true);
  await wait(() => snapshotOf(A).messages.some(m => m.role === 'task' && m.kind === 'answer' && m.text === '用第二版'), A);
  await wait(() => has(F, 'system', '「甲」直接向你汇报：离线测试汇报：收到你的回答：用第二版'), F);
  assert.equal(help(F), null); assert.ok(has(F, 'system', '你回答「甲」：用第二版'));
  assert.equal(await noteJs(F, 'document.getElementById("chat-input").value'), '');
  await wait(async () => await noteJs(A, `[...document.querySelectorAll('.message[data-role=task] .message-label')].some(n => n.textContent === '你对求助的回答')`), A);
  const helpAnswered = true;
  
  // 附件随传话交给甲：甲用附件 ID 读到内容；带队者派活时也能把本次附件交给成员，没有附件时拒绝。
  await calm(); await mkdir(inbox, { recursive: true });
  const path = join(inbox, '传话附件.txt'); await writeFile(path, '暗号：青柠', 'utf8'); await F.agent.receive(path);
  await noteJs(F, `window.fileBuddy.command('chat-summon',{to:'甲',text:'看看附件'})`);
  await wait(() => heard(F, A, '离线测试回复：暗号：青柠'), F);
  assert.equal(snapshotOf(A).messages.filter(m => m.kind === 'say').at(-1).file, '传话附件.txt');
  const fileLabel = `「${F.name}」对你说 · 附件：传话附件.txt`;
  await wait(async () => await noteJs(A, `[...document.querySelectorAll('.message[data-role=task] .message-label')].some(n => n.textContent === ${JSON.stringify(fileLabel)})`), A);
  await calm();
  await noteJs(F, `window.fileBuddy.command('chat-send',{text:'派活带附件：总结附件'})`); await wait(() => phase(F) === 'done', F);
  assert.ok(has(F, 'assistant', '离线测试：「甲」交回：离线测试：暗号：青柠'), snapshotOf(F).messages.at(-1)?.text);
  assert.equal(snapshotOf(A).messages.filter(m => m.role === 'task' && m.kind === 'task').at(-1).file, '传话附件.txt');
  F.agent.removeAttachment();
  await noteJs(F, `window.fileBuddy.command('chat-send',{text:'派活带附件：总结附件'})`); await wait(() => ['done', 'failed'].includes(phase(F)), F);
  assert.ok(has(F, 'assistant', '离线工具未执行：本次消息没有附件'), snapshotOf(F).messages.at(-1)?.text);
  const attachmentPassed = true;

  // 乙正忙：默认回一个 OK，对话框和桌宠一起抖一抖。
  await calm();
  await noteJs(B, `window.fileBuddy.command('chat-send',{text:'等待停止'})`); await wait(() => phase(B) === 'working', B);
  await waitFor(() => !F.meeting && !F.composing && !['working', 'confirming', 'stopping'].includes(phase(F)));
  await noteJs(F, `window.fileBuddy.command('chat-summon',{to:'乙',text:'在忙吗'})`);
  await wait(async () => await B.pet.webContents.executeJavaScript('document.body.dataset.emote') === 'shake', B);
  await wait(() => has(F, 'system', '「乙」回：OK（没有回复'), F);
  await waitFor(async () => { const v = await bubble(B); return v?.text === 'OK' && v.kind === 'ok' && v.shaking; });
  assert.equal(phase(B), 'working');
  await noteJs(B, 'window.fileBuddy.command("chat-stop")'); await wait(() => phase(B) === 'idle', B);
  const busyOk = true;

  // 拒绝：自己正忙、不认识的名字、没写话、不在小队、文件垫和对话框都不能召唤。
  await waitFor(() => !F.meeting && !F.composing);
  await noteJs(F, `window.fileBuddy.command('chat-send',{text:'等待停止'})`); await wait(() => phase(F) === 'working', F);
  assert.ok((await noteJs(F, rejected(`window.fileBuddy.command('chat-summon',{to:'甲',text:'嗨'})`))).includes('正在处理当前指令'));
  await noteJs(F, 'window.fileBuddy.command("chat-stop")'); await wait(() => phase(F) === 'idle', F);
  assert.ok((await noteJs(F, rejected(`window.fileBuddy.command('chat-summon',{to:'戊',text:'嗨'})`))).includes('小队里没有叫'));
  assert.ok((await noteJs(F, rejected(`window.fileBuddy.command('chat-summon',{to:'甲',text:'  '})`))).includes('写上要对'));
  assert.ok((await noteJs(C, rejected(`window.fileBuddy.command('chat-summon',{to:'甲',text:'嗨'})`))).includes('还没有加入小队'));
  assert.ok((await F.pet.webContents.executeJavaScript(rejected(`window.fileBuddy.command('chat-summon',{to:'甲',text:'嗨'})`))).length > 0);
  assert.equal(F.bubble.isFocusable(), false);
  assert.ok((await F.bubble.webContents.executeJavaScript(rejected(`window.fileBuddy.command('chat-send',{text:'越权'})`))).length > 0);
  clearTeam();
  const unexpected = diagnostic.filter(message => !/Content Security Policy|connect-src/.test(message)); assert.deepEqual(unexpected, []);
  console.log(JSON.stringify({ summonSmoke: 'passed', suggest: true, completed, composedBySummoner: true, walked, bubble: true, talkedBack, reported, repeatGate, roundLimit, questionGate: true, helpAnswered, attachmentPassed,
    sayLabel: true, busyOk, selfBusyRejected: true, rejected: true, bubbleUnfocusable: true, diagnostic: unexpected }));
}
