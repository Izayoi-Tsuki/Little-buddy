import { app, BrowserWindow, Menu, Tray, nativeImage, protocol, ipcMain, screen, globalShortcut, dialog, session, shell } from 'electron';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ORIGIN, trustedSender, payloadWithinLimit } from './security.mjs';
import { BUDDY_LAYOUT, NOTE_SIZE, EDITOR_SIZE, BUDDY_LIMITS, PHASES, SUMMON_LIMIT, buddyHitTest, clampBuddyPosition, notePosition, sanitizeBuddyProfile, parseReplyTarget,
  TALK_ROUNDS, TALK_GATES, openTalk, talkGate } from '../src/file-buddy.mjs';
import { rankBars } from '../src/buddy-rank.mjs';
import { nativeAlive, windowVisible } from './buddy-lifecycle.mjs';
import { BuddyAgent } from './buddy-agent.mjs';
import { createQoderSession } from './buddy-qoder.mjs';
import { createDeepSeekSession } from './buddy-deepseek.mjs';
import { parseRegistry, parseRegistrySquads, serializeRegistry, assertUniqueName, createBuddyEntry, suggestProfile, spawnPosition, besidePosition } from './buddy-registry.mjs';
import { squadOf, squadView, linkOptions, applyLink, leaveSquad, nextSquadColor, squadContext, squadFolder, dispatchTarget, TEAM_LIMIT } from './buddy-squads.mjs';
import { listSquadFiles, readSquadFile, saveSquadFile, squadFolderPath } from './squad-files.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SMOKE = process.argv.includes('--smoke-test');
// 配置了 DEEPSEEK_API_KEY 就直连 DeepSeek，否则沿用 Qoder SDK；密钥只在建立会话时从环境变量读取。
const PROVIDER = !SMOKE && process.env.DEEPSEEK_API_KEY?.trim() ? 'DeepSeek' : 'Qoder';
app.setName('Papertrail File Buddy');
app.setPath('userData', SMOKE ? join(ROOT, '.buddy-test-data') : join(app.getPath('appData'), 'Papertrail File Buddy'));
if (process.platform === 'win32') app.setAppUserModelId('com.papertrail.file-buddy');
const STATIC = new Set(['/file-buddy.html', '/file-buddy.css', '/file-note.html', '/file-note.css', '/buddy-edit.html', '/buddy-edit.css', '/buddy-link.html', '/buddy-link.css',
  '/buddy-bubble.html', '/buddy-bubble.css',
  ...['file-buddy', 'file-buddy-view', 'file-note', 'buddy-edit', 'buddy-link', 'buddy-bubble', 'buddy-rank', 'scene', 'office-layout'].map(name => `/src/${name}.mjs`)]);
const MIME = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript' };
protocol.registerSchemesAsPrivileged([{ scheme: 'papertrail', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const locked = app.requestSingleInstanceLock();
// 每只桌宠有自己的文件垫窗口、便利贴窗口和 agent 会话；托盘、快捷键、收纳箱、设定窗口和组队卡片共用。
const buddies = new Map();
let tray, hitTimer, registryTimer, createSession, editor, editorLoading, editing = null, quitting = false;
let squads = [], linker, linkerLoading, linking = null;
// 派活：成员 ID → 进行中的任务。带队者一次只有一个工具作业，所以一次只派一项。
const tasks = new Map(), TASK_TIMEOUT = 5 * 60 * 1000, REPLY_LIMIT = 6000;
// 斜杠召唤：被召唤者 ID → 等它回话的那次召唤。气泡窗口只显示文字，没有任何命令权限。
// 一段对话过了门控（句数、重复、互相反问）或有一只主动求助，就停下来等用户决定：
// helps 是发起召唤的那只 ID → 求助，等待期间这一对不接新的对话和派活。
const relays = new Map(), helps = new Map(), RELAY_TIMEOUT = 60 * 1000, BUBBLE_SIZE = { width: 176, height: 60 }, BUBBLE_TEXT = 120;
const helpOf = id => [...helps.values()].find(h => [h.origin, h.asker, h.peer].includes(id)) ?? null;
let registryWrite = Promise.resolve(), registryFlushed = false;
const diagnostic = [];
const smokeInbox = join(ROOT, '.buddy-test-data', '收纳箱', `${Date.now()}-${process.pid}`);
const inbox = () => SMOKE ? smokeInbox : join(app.getPath('documents'), '纸间收纳箱');
const webPreferences = () => ({ preload: join(ROOT, 'desktop/buddy-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
const send = (window, channel, value) => { if (window && !window.isDestroyed() && !window.webContents.isLoadingMainFrame()) window.webContents.send(channel, value); };
const ordered = () => [...buddies.values()];
const nameOf = id => buddies.get(id)?.name ?? '？';
const profile = b => ({ id: b.id, name: b.name, role: b.role, look: { ...b.look }, squad: squadView(squads, b.id, nameOf) });
// 求助卡片只给发起召唤的那只的便利贴；这一对都知道自己在等谁的便利贴。
function helpView(b) {
  const h = helps.get(b.id); if (!h) return null;
  return { id: h.id, asker: nameOf(h.asker), peer: nameOf(h.peer), topic: h.topic, asked: h.reason === 'help',
    reason: `${h.reason === 'help' ? `「${nameOf(h.asker)}」` : '两只'}${TALK_GATES[h.reason]}`, text: h.text };
}
const snapshotOf = b => { const h = helpOf(b.id); return { ...b.agent.snapshot(), buddy: profile(b), help: helpView(b), waiting: h ? nameOf(h.origin) : null }; };
const menuText = text => text.replace(/&/g, '&&');
const report = error => { console.error(error); if (!SMOKE && !quitting) dialog.showErrorBox('文件桌宠', error.message); };
// 请求方由窗口本身识别；页面不能通过参数冒充别的桌宠。
function sender(event) {
  if (quitting) throw new Error('文件桌宠正在退出');
  for (const b of buddies.values()) {
    if (trustedSender(event, b.pet, '/file-buddy.html')) return { kind: 'pet', buddy: b };
    if (trustedSender(event, b.note, '/file-note.html')) return { kind: 'note', buddy: b };
  }
  if (trustedSender(event, editor, '/buddy-edit.html')) return { kind: 'editor' };
  if (trustedSender(event, linker, '/buddy-link.html')) return { kind: 'linker' };
  throw new Error('请求不是来自受信任的主页面');
}
function broadcast(b) {
  if (quitting || buddies.get(b.id) !== b) return;
  const state = snapshotOf(b); send(b.pet, 'buddy:state', state); send(b.note, 'buddy:state', state); updateTray();
}
function broadcastAll() { for (const b of ordered()) broadcast(b); }
// 小队变化时所有桌宠都重新收到状态：同队成员的军衔和说明要一起变。
function setSquads(next) { squads = next; broadcastAll(); saveRegistry(); }
function persistRegistry() {
  const content = serializeRegistry(ordered(), squads);
  registryWrite = registryWrite.then(async () => {
    const directory = app.getPath('userData'); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'buddies.tmp'), content, 'utf8'); await rename(join(directory, 'buddies.tmp'), join(directory, 'buddies.json'));
  }).catch(error => console.warn('桌宠名册保存失败：', error.message));
  return registryWrite;
}
function saveRegistry() { clearTimeout(registryTimer); registryTimer = setTimeout(persistRegistry, 300); }
async function loadRegistry() {
  const read = async name => { try { const raw = await readFile(join(app.getPath('userData'), name), 'utf8'); return raw.length < 65536 ? raw : null; } catch { return null; } };
  // 自检每次从默认桌宠开始；正式实例首次升级时沿用旧版单桌宠的位置。
  if (SMOKE) return { entries: parseRegistry(''), squads: [] };
  const raw = await read('buddies.json');
  if (raw) { const entries = parseRegistry(raw); return { entries, squads: parseRegistrySquads(raw, entries) }; }
  let legacy = null; try { legacy = JSON.parse(await read('position.json') ?? 'null')?.position ?? null; } catch { legacy = null; }
  return { entries: parseRegistry('', legacy), squads: [] };
}
function areaFor(position) {
  return position ? screen.getDisplayNearestPoint({ x: Math.round(position.x + BUDDY_LAYOUT.width / 2), y: Math.round(position.y + BUDDY_LAYOUT.height / 2) }).workArea : screen.getPrimaryDisplay().workArea;
}
function occupied(except = null) {
  return ordered().filter(b => b !== except).map(b => nativeAlive(b.pet) ? { x: b.pet.getPosition()[0], y: b.pet.getPosition()[1] } : b.position);
}
function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('console-message', event => { if (SMOKE && event.level === 'error') diagnostic.push(event.message); });
}
function positionNote(b) {
  if (quitting || !nativeAlive(b.note) || !nativeAlive(b.pet)) return;
  const bounds = b.pet.getBounds(), position = notePosition(bounds, areaFor(bounds)); b.note.setPosition(position.x, position.y);
}
async function showNote(b) {
  if (quitting || !nativeAlive(b.pet) || buddies.get(b.id) !== b) return;
  if (!nativeAlive(b.note)) {
    b.note = new BrowserWindow({ width: NOTE_SIZE.width, height: NOTE_SIZE.height, frame: false, resizable: false, maximizable: false, minimizable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, backgroundColor: '#fff4bd', title: `${b.name} · 纸间便利贴`, webPreferences: webPreferences() });
    secureWindow(b.note);
    b.note.on('close', event => { if (!quitting && buddies.get(b.id) === b) { event.preventDefault(); b.note.hide(); } });
    b.noteLoading = b.note.loadURL(`${APP_ORIGIN}/file-note.html`);
  }
  await b.noteLoading;
  if (quitting || !nativeAlive(b.note) || !nativeAlive(b.pet)) return;
  positionNote(b); send(b.note, 'buddy:state', snapshotOf(b));
  if (!SMOKE && windowVisible(b.pet, quitting)) { b.note.show(); b.note.focus(); }
}
function showPet(b) {
  if (quitting || !nativeAlive(b.pet)) return;
  const bounds = b.pet.getBounds(), position = clampBuddyPosition(bounds, areaFor(bounds)); b.pet.setPosition(position.x, position.y);
  b.pet.showInactive(); send(b.pet, 'buddy:visibility', true); broadcast(b);
}
const anyVisible = () => ordered().some(b => windowVisible(b.pet, quitting));
function showAll() { for (const b of ordered()) showPet(b); }
function hideAll() {
  cancelLink();
  for (const b of ordered()) {
    b.dragging = null;
    if (nativeAlive(b.pet)) b.pet.hide();
    if (nativeAlive(b.note)) b.note.hide();
    if (nativeAlive(b.bubble)) b.bubble.hide();
    send(b.pet, 'buddy:visibility', false);
  }
  updateTray();
}
const toggleAll = () => anyVisible() ? hideAll() : showAll();
function resetPosition(b) {
  if (quitting || !nativeAlive(b.pet)) return;
  const p = spawnPosition(occupied(b), screen.getPrimaryDisplay().workArea, BUDDY_LAYOUT);
  b.pet.setPosition(p.x, p.y); b.position = p; saveRegistry(); positionNote(b); showPet(b);
}
async function spawn(entry) {
  const b = { ...entry, pet: null, note: null, noteLoading: null, bubble: null, bubbleLoading: null, bubbleTimer: null, walking: null, composing: null, dragging: null, ignoreMouse: true, receiving: false };
  b.agent = new BuddyAgent({ createSession, inbox: inbox(), onChange: () => { broadcast(b); watchTask(b); watchRelay(b); watchCompose(b); }, label: PROVIDER, persona: { name: b.name, role: b.role },
    squad: { context: () => squadContext(squads, b.id, nameOf), tool: (name, args, signal) => squadTool(b, name, args, signal) } });
  buddies.set(b.id, b);
  const position = clampBuddyPosition(b.position, areaFor(b.position));
  b.pet = new BrowserWindow({ ...position, width: BUDDY_LAYOUT.width, height: BUDDY_LAYOUT.height,
    transparent: true, frame: false, resizable: false, maximizable: false, minimizable: false, hasShadow: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, backgroundColor: '#00000000', title: `${b.name} · 纸间文件桌宠`, webPreferences: webPreferences() });
  secureWindow(b.pet); b.pet.setIgnoreMouseEvents(true, { forward: true });
  b.pet.on('close', event => { if (!quitting && buddies.get(b.id) === b) { event.preventDefault(); hideAll(); } });
  b.pet.on('show', () => send(b.pet, 'buddy:visibility', true)); b.pet.on('hide', () => send(b.pet, 'buddy:visibility', false));
  b.pet.on('move', () => { positionNote(b); positionBubble(b); }); b.pet.on('closed', () => { b.dragging = null; });
  await b.pet.loadURL(`${APP_ORIGIN}/file-buddy.html`);
  return b;
}
// 删除只回收这只桌宠的窗口和会话；收纳箱里已生成的文件和原文件都不动。
async function removeBuddy(b) {
  if (quitting || buddies.get(b.id) !== b) return false;
  if (buddies.size <= 1) throw new Error('至少保留一只桌宠');
  buddies.delete(b.id); b.dragging = null; b.composing = null; stopWalk(b); clearTimeout(b.bubbleTimer);
  if (editing === b.id) closeEditor();
  if (linking && [linking.dragged, linking.target].includes(b.id)) cancelLink();
  if (nativeAlive(b.note)) b.note.destroy();
  if (nativeAlive(b.bubble)) b.bubble.destroy();
  if (nativeAlive(b.pet)) b.pet.destroy();
  for (const [id, h] of helps) if ([h.origin, h.asker, h.peer].includes(b.id)) helps.delete(id);
  squads = leaveSquad(squads, b.id); broadcastAll();
  saveRegistry(); updateTray();
  tasks.get(b.id)?.finish(`「${b.name}」已被删除，没有完成派来的任务`);
  const relay = relays.get(b.id); if (relay) { relays.delete(b.id); clearTimeout(relay.timer); }
  await b.agent.dispose();
  return true;
}
async function confirmRemove(b) {
  if (quitting || buddies.get(b.id) !== b) return;
  if (buddies.size <= 1) { await dialog.showMessageBox({ type: 'info', title: '删除桌宠', message: '至少保留一只桌宠', detail: '可以先新建一只，再删除这只。', noLink: true }); return; }
  const { response } = await dialog.showMessageBox({ type: 'warning', buttons: ['删除', '取消'], defaultId: 1, cancelId: 1, noLink: true, title: '删除桌宠',
    message: `删除「${b.name}」？`, detail: `${b.agent.busy() ? '正在进行的回复会被停止。' : ''}它的便利贴对话会一起清除；收纳箱里已生成的文件和你的原文件都不受影响。` });
  if (response === 0) await removeBuddy(b);
}
function editorState() {
  const b = editing ? buddies.get(editing) : null;
  return { mode: b ? 'edit' : 'create', profile: b ? profile(b) : suggestProfile(ordered()), provider: PROVIDER, limits: BUDDY_LIMITS };
}
async function openEditor(b = null) {
  if (quitting) return;
  if (!b && buddies.size >= BUDDY_LIMITS.count) throw new Error(`最多同时养 ${BUDDY_LIMITS.count} 只桌宠`);
  editing = b?.id ?? null;
  if (!nativeAlive(editor)) {
    editor = new BrowserWindow({ width: EDITOR_SIZE.width, height: EDITOR_SIZE.height, frame: false, resizable: false, maximizable: false, minimizable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, backgroundColor: '#fff4bd', title: '桌宠设定', webPreferences: webPreferences() });
    secureWindow(editor);
    const current = editor; current.on('closed', () => { if (editor === current) { editor = null; editorLoading = null; editing = null; } });
    editorLoading = editor.loadURL(`${APP_ORIGIN}/buddy-edit.html`);
  }
  await editorLoading;
  if (quitting || !nativeAlive(editor)) return;
  const area = b && nativeAlive(b.pet) ? areaFor(b.pet.getBounds()) : screen.getPrimaryDisplay().workArea;
  editor.setPosition(Math.round(area.x + (area.width - EDITOR_SIZE.width) / 2), Math.round(area.y + (area.height - EDITOR_SIZE.height) / 2));
  send(editor, 'buddy:edit', editorState());
  if (!SMOKE) { editor.show(); editor.focus(); }
}
function closeEditor() { editing = null; if (nativeAlive(editor)) editor.close(); }
// 名字立即生效；角色写入设定，已建立的会话从下一次新对话起使用。
async function saveEditor(value) {
  const target = editing ? buddies.get(editing) : null;
  if (editing && !target) { closeEditor(); throw new Error('这只桌宠已经被删除'); }
  if (target) {
    const clean = sanitizeBuddyProfile(value); assertUniqueName(ordered(), clean.name, target.id);
    Object.assign(target, clean); target.agent.setPersona({ name: clean.name, role: clean.role });
    if (nativeAlive(target.pet)) target.pet.setTitle(`${clean.name} · 纸间文件桌宠`);
    if (nativeAlive(target.note)) target.note.setTitle(`${clean.name} · 纸间便利贴`);
    broadcastAll(); saveRegistry(); closeEditor(); return profile(target);
  }
  const entry = createBuddyEntry(value, ordered());
  entry.position = spawnPosition(occupied(), screen.getPrimaryDisplay().workArea, BUDDY_LAYOUT);
  const b = await spawn(entry); saveRegistry(); closeEditor();
  if (!quitting && !SMOKE) showPet(b);
  return profile(b);
}
// 组队：把一只拖到另一只身上松手，弹出卡片选择关系；取消时把拖过来的那只送回原位。
const LINK_WIDTH = 260;
const linkHeight = state => 150 + state.options.length * 43 + (state.note ? 60 : 0);
function dropTarget(b) {
  const [x, y] = b.pet.getPosition(), cx = x + BUDDY_LAYOUT.width / 2, cy = y + BUDDY_LAYOUT.height / 2;
  let best = null, distance = Infinity;
  for (const other of buddies.values()) {
    if (other === b || !nativeAlive(other.pet) || (!SMOKE && !windowVisible(other.pet, quitting))) continue;
    const r = other.pet.getBounds(), d = Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy);
    if (cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height && d < distance) { best = other; distance = d; }
  }
  return best;
}
function linkState() {
  const a = buddies.get(linking?.dragged), b = buddies.get(linking?.target); if (!a || !b) return null;
  const host = squadOf(squads, a.id) ?? squadOf(squads, b.id);
  return { ...linkOptions(squads, a.id, b.id, nameOf), dragged: profile(a), target: profile(b), color: host?.color ?? nextSquadColor(squads) };
}
function moveBuddy(b, position) {
  if (!nativeAlive(b.pet)) return;
  b.pet.setPosition(position.x, position.y); b.position = { x: position.x, y: position.y }; positionNote(b); saveRegistry();
}
function closeLinker() { linking = null; const window = linker; linker = null; linkerLoading = null; if (nativeAlive(window)) window.close(); }
function restoreDragged(pending) {
  const a = buddies.get(pending?.dragged); if (a && !quitting) moveBuddy(a, { x: pending.origin[0], y: pending.origin[1] });
}
function cancelLink() { const pending = linking; if (!pending) return; closeLinker(); restoreDragged(pending); }
// 卡片还开着时又拖了一次：沿用同一个卡片窗口，先把上一次拖过来的那只送回去。
async function openLinker(a, b, origin) {
  if (quitting) return;
  const previous = linking;
  linking = { dragged: a.id, target: b.id, origin: previous?.dragged === a.id ? previous.origin : origin };
  if (previous && previous.dragged !== a.id) restoreDragged(previous);
  if (!nativeAlive(linker)) {
    linker = new BrowserWindow({ width: LINK_WIDTH, height: 240, frame: false, resizable: false, maximizable: false, minimizable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, backgroundColor: '#fff4bd', title: '桌宠组队', webPreferences: webPreferences() });
    secureWindow(linker);
    const current = linker; current.on('closed', () => { if (linker === current) { linker = null; linkerLoading = null; cancelLink(); } });
    linkerLoading = linker.loadURL(`${APP_ORIGIN}/buddy-link.html`);
  }
  await linkerLoading;
  const state = linkState();
  if (quitting || !nativeAlive(linker) || !state || linking?.dragged !== a.id) { if (!state) cancelLink(); return; }
  const target = b.pet.getBounds(), area = areaFor(target), height = linkHeight(state);
  const above = target.y - height - 8 >= area.y, y = above ? target.y - height - 8 : target.y + target.height + 8;
  const p = clampBuddyPosition({ x: Math.round(target.x + target.width / 2 - LINK_WIDTH / 2), y }, area, { width: LINK_WIDTH, height });
  linker.setBounds({ x: p.x, y: p.y, width: LINK_WIDTH, height });
  send(linker, 'buddy:link', state);
  if (!SMOKE) { linker.show(); linker.focus(); }
}
// 只接受当前局面下的可选关系；组队成功后把拖过来的那只放到对方身边，两只一起冒爱心眼。
function chooseLink(optionId) {
  const pending = linking, a = buddies.get(pending?.dragged), b = buddies.get(pending?.target);
  if (!a || !b) { cancelLink(); throw new Error('这只桌宠已经不在了'); }
  const next = applyLink(squads, a.id, b.id, optionId, { nameOf, newId: randomUUID });
  closeLinker(); setSquads(next);
  if (optionId === 'leave') moveBuddy(a, { x: pending.origin[0], y: pending.origin[1] });
  else if (nativeAlive(b.pet)) {
    const [x, y] = b.pet.getPosition(); moveBuddy(a, besidePosition({ x, y }, occupied(a), areaFor(b.pet.getBounds()), BUDDY_LAYOUT));
    for (const one of [a, b]) send(one.pet, 'buddy:emote', { kind: 'love', ms: 1600 });
  }
  return squadView(squads, a.id, nameOf);
}
function finishDrag(b, origin) {
  const [x, y] = b.pet.getPosition(), target = Math.hypot(x - origin[0], y - origin[1]) > 5 ? dropTarget(b) : null;
  if (target) { openLinker(b, target, origin).catch(report); return; }
  b.position = { x, y }; saveRegistry();
}
function setLinkHover(b, target) {
  const id = target?.id ?? null; if (b.linkHover === id) return;
  const old = buddies.get(b.linkHover); if (old) send(old.pet, 'buddy:link-target', false);
  b.linkHover = id; if (target) send(target.pet, 'buddy:link-target', true);
}
// 小队工具按调用这一刻的小队关系执行；文件只落在本队文件夹里。
async function squadTool(b, name, args, signal) {
  const s = squadOf(squads, b.id);
  if (!s) throw new Error('你现在不在小队里，不能使用小队工具');
  if (name === 'list_squad_files') return listSquadFiles(inbox(), s);
  if (name === 'read_squad_file') return readSquadFile(inbox(), s, args.name);
  if (name === 'save_squad_file') {
    const result = await saveSquadFile(inbox(), s, args.name, args.content);
    b.agent.note(`已在小队文件夹新建：${result.output}${result.renamed ? '（同名已加序号）' : ''}`);
    return { kind: 'saved', name: result.name, renamed: result.renamed, folder: squadFolder(s).join('/') };
  }
  return dispatchTask(b, args, signal);
}
// 派出一项任务并等成员做完；带队者停止时经 signal 把成员一起停下，超时也停下成员。
function dispatchTask(lead, args, signal) {
  const instruction = typeof args.instruction === 'string' ? args.instruction.trim() : '';
  if (!instruction || instruction.length > 4000) throw new Error('任务说明需要 1 到 4000 个字符');
  // 附件只能是带队者这一轮本来就能读的那一个。
  const file = args.with_attachment === true ? lead.agent.activeFile : null;
  if (args.with_attachment === true && !file) throw new Error('本次消息没有附件可以交给成员');
  const member = buddies.get(dispatchTarget(squads, lead.id, args.member, { nameOf, tasked: id => tasks.has(id),
    busy: id => !!buddies.get(id)?.agent.busy() || !!buddies.get(id)?.receiving || !!helpOf(id), working: () => ordered().filter(x => x.agent.busy()).length }));
  if (signal.aborted) throw new Error('已停止，没有派出任务');
  const messageId = member.agent.sendTask(instruction, lead.name, 'task', { file });
  lead.agent.note(`已派给「${member.name}」${file ? `（附件：${file.name}）` : ''}：${instruction}`);
  lead.agent.setActivity(`正在等「${member.name}」完成派出的任务…`);
  return new Promise((resolve, reject) => {
    const task = { lead: lead.id, approval: null };
    const settle = () => { tasks.delete(member.id); clearTimeout(task.timer); signal.removeEventListener('abort', onAbort); };
    // 收取任务消息之后成员的回复，交回带队者。
    task.finish = error => {
      if (tasks.get(member.id) !== task) return; settle();
      const messages = member.agent.state.messages, start = messages.findIndex(m => m.id === messageId);
      const reply = start < 0 ? '' : messages.slice(start + 1).filter(m => m.role === 'assistant').map(m => m.text).join('\x0a\x0a').slice(0, REPLY_LIMIT);
      const ok = !error && member.agent.state.phase === 'done';
      const reason = ok ? '' : error ?? (member.agent.state.error || `「${member.name}」没有完成任务（可能被停止）`);
      lead.agent.note(ok ? `「${member.name}」已交回结果` : `「${member.name}」没有完成：${reason}`);
      resolve({ member: member.name, ok, reply, error: reason });
    };
    const onAbort = () => {
      if (tasks.get(member.id) !== task) return; settle();
      try { if (member.agent.busy() && !member.agent.stopped) member.agent.stop(); } catch { /* 成员已在停止或退出 */ }
      reject(new Error('已停止；派出的任务也一并停止'));
    };
    task.timer = setTimeout(() => {
      task.finish(`「${member.name}」超过 5 分钟没有完成，已停止它`);
      try { member.agent.stop(); } catch { /* 已结束 */ }
    }, TASK_TIMEOUT);
    signal.addEventListener('abort', onAbort, { once: true });
    tasks.set(member.id, task); watchTask(member);
  });
}
// 成员每次状态变化时检查：做完就交回结果；需要确认写入时把它的便利贴打开给用户看。
function watchTask(b) {
  const task = tasks.get(b.id); if (!task) return;
  if (!b.agent.busy()) { task.finish(); return; }
  const approval = b.agent.state.approval?.id;
  if (approval && task.approval !== approval) { task.approval = approval; showNote(b).catch(report); }
}
// 派活链上任一只停止，整条链一起停：停带队者会经 signal 停掉成员，停成员时把带队者也停下。
function stopTeam(b) {
  const lead = buddies.get(tasks.get(b.id)?.lead);
  b.agent.stop();
  if (lead?.agent.busy() && !lead.agent.stopped) try { lead.agent.stop(); } catch { /* 已在停止 */ }
}
// 斜杠召唤：甲先用自己的会话把用户的原话加工成要对乙说的话，再走到乙身边冒泡传话，甲当前的附件随话交给乙；
// 乙空闲就交给它的会话照此回应，忙、失败或超时没有回话时默认回一个 OK 并抖一抖。甲自己正忙时不能召唤。
function summon(a, value) {
  const s = squadOf(squads, a.id); if (!s) throw new Error('还没有加入小队，不能召唤同组成员');
  const to = typeof value?.to === 'string' ? value.to.trim() : '', text = typeof value?.text === 'string' ? value.text.trim() : '';
  const b = s.members.map(id => buddies.get(id)).find(x => x && x !== a && x.name === to);
  if (!b) throw new Error(`小队里没有叫「${to.slice(0, 20)}」的同伴；可以召唤：${s.members.filter(id => id !== a.id).map(id => `「${nameOf(id)}」`).join('、')}`);
  if (!text) throw new Error(`写上要对「${b.name}」说的话，例如 /${b.name} 你好`);
  if (text.length > SUMMON_LIMIT) throw new Error(`一次最多说 ${SUMMON_LIMIT} 个字`);
  const waiting = helpOf(a.id) ?? helpOf(b.id);
  if (waiting) throw new Error(`「${nameOf(waiting.asker)}」和「${nameOf(waiting.peer)}」在等你决定，先在「${nameOf(waiting.origin)}」便利贴的求助卡片上处理`);
  if (a.walking || a.meeting || a.composing) throw new Error('正在走过去传话，请稍等');
  if (a.agent.busy() || a.receiving) throw new Error('正在处理当前指令，等这次回复完成后再召唤');
  // compose 会同步触发 onChange，先拿到消息 ID 再登记，最后手动检查一次。
  const file = a.agent.state.file ? structuredClone(a.agent.state.file) : null;
  const messageId = a.agent.compose(text, b.name, BUBBLE_TEXT, file?.name);
  a.composing = { to: b.id, messageId, file }; watchCompose(a);
}
// 甲加工完就带着这段话出发；停止或失败就不去，对方已不在小队也不去。
function watchCompose(a) {
  const job = a.composing; if (!job || a.agent.busy()) return; a.composing = null;
  const state = a.agent.state, start = state.messages.findIndex(m => m.id === job.messageId), b = buddies.get(job.to);
  if (state.phase !== 'done' || start < 0) return;
  const raw = state.messages.slice(start + 1).filter(m => m.role === 'assistant').map(m => m.text).join(' ').trim();
  // 模型偶尔把整句话包在引号里，只去掉成对包住整句的那一层。
  const pair = { '「': '」', '“': '”', '"': '"' }[raw[0]], said = (pair && raw.length > 2 && raw.at(-1) === pair && !raw.slice(1, -1).includes(pair) ? raw.slice(1, -1).trim() : raw).slice(0, SUMMON_LIMIT);
  if (!b || !squadOf(squads, a.id)?.members.includes(b.id)) { a.agent.note('对方已不在小队里，没有去传话'); return; }
  if (!said) { a.agent.note(`没想好要对「${b.name}」说什么，没有去传话`); return; }
  a.meeting = true; meet(a, b, said, openTalk(said, { origin: a.id, file: job.file })).catch(report).finally(() => { a.meeting = false; });
}
async function meet(a, b, text, talk) {
  if (nativeAlive(a.pet) && nativeAlive(b.pet)) {
    const [x, y] = b.pet.getPosition(), [ax, ay] = a.pet.getPosition();
    // 已经挨在一起就不用走了。
    if (Math.hypot(ax - x, ay - y) > BUDDY_LAYOUT.width + 20) await walkTo(a, besidePosition({ x, y }, occupied(a), areaFor(b.pet.getBounds()), BUDDY_LAYOUT));
  }
  if (quitting || buddies.get(a.id) !== a || buddies.get(b.id) !== b) return;
  await showBubble(a, text);
  if (!talkTo(a, b, text, talk)) answer(a, b, '');
}
// 按缓动曲线一步步挪窗口；被拖动、删除或退出时停在原地。
function walkTo(b, target) {
  stopWalk(b);
  return new Promise(resolve => {
    if (!nativeAlive(b.pet)) { resolve(false); return; }
    const [x0, y0] = b.pet.getPosition(), steps = SMOKE ? 4 : 14;
    if (Math.hypot(target.x - x0, target.y - y0) < 2) { resolve(true); return; }
    send(b.pet, 'buddy:emote', { kind: 'walk', ms: steps * 30 + 150 });
    let step = 0;
    const walk = { resolve, timer: setInterval(() => {
      if (quitting || !nativeAlive(b.pet) || b.dragging || buddies.get(b.id) !== b) { stopWalk(b); return; }
      const t = ++step / steps, e = t < .5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
      if (step < steps) { b.pet.setPosition(Math.round(x0 + (target.x - x0) * e), Math.round(y0 + (target.y - y0) * e)); return; }
      clearInterval(walk.timer); b.walking = null; moveBuddy(b, target); resolve(true);
    }, 30) };
    b.walking = walk;
  });
}
function stopWalk(b) {
  const walk = b.walking; if (!walk) return; b.walking = null; clearInterval(walk.timer);
  if (nativeAlive(b.pet) && !quitting) { const [x, y] = b.pet.getPosition(); b.position = { x, y }; saveRegistry(); }
  walk.resolve(false);
}
function positionBubble(b) {
  if (quitting || !nativeAlive(b.bubble) || !nativeAlive(b.pet)) return;
  const r = b.pet.getBounds(), p = clampBuddyPosition({ x: Math.round(r.x + r.width / 2 - BUBBLE_SIZE.width / 2), y: r.y - BUBBLE_SIZE.height + 6 }, areaFor(r), BUBBLE_SIZE);
  b.bubble.setPosition(p.x, p.y);
}
// 头顶对话框：透明、不可聚焦、不接鼠标，文字长短决定停留时间。
async function showBubble(b, text, { kind = 'say', shake = false } = {}) {
  if (quitting || !nativeAlive(b.pet) || buddies.get(b.id) !== b) return;
  if (!nativeAlive(b.bubble)) {
    b.bubble = new BrowserWindow({ width: BUBBLE_SIZE.width, height: BUBBLE_SIZE.height, transparent: true, frame: false, resizable: false, maximizable: false, minimizable: false,
      hasShadow: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, backgroundColor: '#00000000', title: `${b.name} · 对话框`, webPreferences: webPreferences() });
    secureWindow(b.bubble); b.bubble.setIgnoreMouseEvents(true);
    b.bubbleLoading = b.bubble.loadURL(`${APP_ORIGIN}/buddy-bubble.html`);
  }
  await b.bubbleLoading;
  if (quitting || !nativeAlive(b.bubble) || !nativeAlive(b.pet)) return;
  const chars = [...String(text).replace(/\s+/g, ' ').trim()], clipped = chars.length > BUBBLE_TEXT ? `${chars.slice(0, BUBBLE_TEXT).join('')}…` : chars.join('');
  // 加载刚完成时 isLoadingMainFrame 可能仍为 true，send() 会丢消息，这里已等到加载完毕，直接发。
  positionBubble(b); b.bubble.webContents.send('buddy:bubble', { text: clipped, kind, shake });
  if (windowVisible(b.pet, quitting)) { b.bubble.showInactive(); b.bubble.moveTop(); }
  clearTimeout(b.bubbleTimer);
  b.bubbleTimer = setTimeout(() => { if (nativeAlive(b.bubble)) b.bubble.hide(); }, Math.min(8000, 2500 + chars.length * 80));
}
// 把 a 的话交给 b 的会话，附件随整段对话传递；kind 为 answer 时是用户对 b 求助的回答，a 是和 b 对话的那只。
// b 忙着、在等用户决定或派不出去时返回 false。
function talkTo(a, b, text, talk, kind = 'say') {
  const idle = !b.agent.busy() && !b.receiving && !tasks.has(b.id) && !relays.has(b.id) && !helpOf(b.id) && ordered().filter(x => x.agent.busy()).length < TEAM_LIMIT;
  let messageId = null;
  if (idle) try { messageId = b.agent.sendTask(text, a.name, kind, { file: talk.file, last: talk.round >= TALK_ROUNDS }); } catch { messageId = null; }
  if (!messageId) return false;
  const relay = { from: a.id, messageId, approval: null, talk };
  relay.timer = setTimeout(() => finishRelay(b, true), RELAY_TIMEOUT);
  relays.set(b.id, relay); watchRelay(b); return true;
}
// 被召唤者做完就把回话带回去；需要确认写入时把它的便利贴打开给用户看。
function watchRelay(b) {
  const relay = relays.get(b.id); if (!relay) return;
  if (!b.agent.busy()) { finishRelay(b); return; }
  const approval = b.agent.state.approval?.id;
  if (approval && relay.approval !== approval) { relay.approval = approval; showNote(b).catch(report); }
}
// 超时只先回 OK，不打断它；它之后的回复留在自己的便利贴上。
function finishRelay(b, timeout = false) {
  const relay = relays.get(b.id); if (!relay) return; relays.delete(b.id); clearTimeout(relay.timer);
  const messages = b.agent.state.messages, start = messages.findIndex(m => m.id === relay.messageId);
  const done = !timeout && start >= 0 && b.agent.state.phase === 'done';
  const reply = done ? messages.slice(start + 1).filter(m => m.role === 'assistant').map(m => m.text).join('\x0a\x0a').trim() : '';
  answer(buddies.get(relay.from), b, reply, relay.talk);
}
// b 对 a 的回话：没有回话默认 OK 并抖一抖；「@用户」是直接对用户说或汇报，不冒对话框，桌宠跳一下、头顶冒感叹号；
// 「@用户 求助」或过了门控，这一对停下来等用户决定；否则是回给 a 的话，冒对话框并交给 a 接着聊，a 忙着就记在 a 的便利贴上。
function answer(a, b, reply, talk = null) {
  if (quitting || buddies.get(b.id) !== b) return;
  const alive = !!a && buddies.get(a.id) === a, { to, text } = parseReplyTarget(reply, a?.name);
  const together = alive && !!squadOf(squads, a.id)?.members.includes(b.id);
  if (to === 'help' && together && talk) { askUser(b, a, text, talk, 'help'); return; }
  if (!text) {
    showBubble(b, 'OK', { kind: 'ok', shake: true }).catch(report); send(b.pet, 'buddy:emote', { kind: 'shake', ms: 900 });
    if (alive) a.agent.note(`「${b.name}」回：OK（没有回复，默认回一个 OK）`);
    return;
  }
  if (to !== 'peer') {
    send(b.pet, 'buddy:emote', { kind: 'report', ms: 2400 });
    // 用户是从发起召唤的那只的便利贴进来的，汇报也记在那里一份。
    const origin = buddies.get(talk?.origin);
    if (origin && origin !== b) origin.agent.note(`「${b.name}」直接向你汇报：${text}`);
    return;
  }
  const gate = talk ? talkGate(talk, text) : null;
  if (together && gate?.reason) { askUser(b, a, text, gate.talk, gate.reason); return; }
  showBubble(b, text, { kind: 'reply' }).catch(report);
  if (!alive) return;
  if (together && gate && talkTo(b, a, text, { ...gate.talk, round: talk.round + 1 })) return;
  a.agent.note(`「${b.name}」回：${text}`);
}
// 这一对停下来等用户：求助的那只跳一下、头顶冒问号，求助卡片置顶在发起召唤的那只的便利贴上并打开它。
function askUser(asker, peer, text, talk, reason) {
  const origin = buddies.get(talk.origin) ?? asker;
  helps.set(origin.id, { id: randomUUID(), origin: origin.id, asker: asker.id, peer: peer.id, text: (text || '没有说明卡在哪').slice(0, 600), topic: talk.topic ?? '', reason, talk });
  send(asker.pet, 'buddy:emote', { kind: 'help', ms: 2400 });
  origin.agent.note(`需要你：${reason === 'help' ? `「${asker.name}」向你求助` : `「${asker.name}」和「${peer.name}」${TALK_GATES[reason]}`}，已停下来等你决定`);
  for (const one of new Set([origin, asker, peer])) broadcast(one);
  showNote(origin).catch(report);
}
// 用户在求助卡片上的选择：我来回答（回答交给求助的那只）、让它们再聊几句（把它最后那句交给对方）或结束；
// 接着聊时句数和重复、反问的计数都重新算，话题和附件沿用。
function settleHelp(origin, value, mode) {
  const help = helps.get(origin.id);
  if (!help || help.id !== value?.id) throw new Error('这次求助已经处理过了');
  const asker = buddies.get(help.asker), peer = buddies.get(help.peer), pair = [...new Set([origin, asker, peer])].filter(Boolean);
  const close = () => { helps.delete(origin.id); for (const one of pair) broadcast(one); };
  if (mode === 'dismiss') { close(); origin.agent.note('已结束这次求助，它们不再接着聊'); return; }
  const text = mode === 'answer' ? (typeof value.text === 'string' ? value.text.trim() : '') : help.text;
  if (!text) throw new Error('写上你的回答');
  if (text.length > SUMMON_LIMIT) throw new Error(`一次最多说 ${SUMMON_LIMIT} 个字`);
  if (!asker || !peer || !squadOf(squads, asker.id)?.members.includes(peer.id)) { close(); throw new Error('它们已经不在同一支小队里，这次求助已结束'); }
  const talk = { ...openTalk(text, { origin: help.talk.origin, file: help.talk.file }), topic: help.topic };
  helps.delete(origin.id);
  const sent = mode === 'answer' ? talkTo(peer, asker, text, talk, 'answer') : talkTo(asker, peer, text, talk);
  if (!sent) { helps.set(origin.id, help); throw new Error(`「${(mode === 'answer' ? asker : peer).name}」正在忙，等它空下来再试`); }
  for (const one of pair) broadcast(one);
  if (mode === 'answer') origin.agent.note(`你回答「${asker.name}」：${text}`);
  else { showBubble(asker, text, { kind: 'reply' }).catch(report); origin.agent.note(`已让「${asker.name}」和「${peer.name}」再聊几句`); }
}
async function openSquadFolder(b) {
  const s = squadOf(squads, b.id); if (!s) throw new Error('这只桌宠已经不在小队里');
  const error = await shell.openPath(await squadFolderPath(inbox(), s)); if (error) throw new Error('暂时无法打开小队文件夹');
}
function stopInteractions() {
  clearInterval(hitTimer); hitTimer = null; clearTimeout(registryTimer);
  for (const b of buddies.values()) { b.dragging = null; b.composing = null; stopWalk(b); clearTimeout(b.bubbleTimer); }
  for (const relay of relays.values()) clearTimeout(relay.timer);
  relays.clear(); helps.clear();
  globalShortcut.unregisterAll();
  if (nativeAlive(tray)) tray.destroy();
  tray = null;
}
function trayImage() {
  const size = 24, pixels = Buffer.alloc(size * size * 4);
  const draw = (x, y, w, h, rgb) => { for (let iy = y; iy < y + h; iy++) for (let ix = x; ix < x + w; ix++) {
    const i = (iy * size + ix) * 4; pixels[i] = rgb[2]; pixels[i + 1] = rgb[1]; pixels[i + 2] = rgb[0]; pixels[i + 3] = 255;
  } };
  draw(5, 2, 14, 16, [62, 95, 73]); draw(3, 7, 18, 9, [107, 148, 116]);
  draw(6, 8, 3, 3, [244, 240, 210]); draw(15, 8, 3, 3, [244, 240, 210]); draw(8, 18, 13, 6, [202, 181, 126]);
  return nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 1 });
}
function buddyMenu(b) {
  const squad = squadView(squads, b.id, nameOf);
  return [
    { label: '打开便利贴聊天', click: () => { showPet(b); showNote(b).catch(report); } },
    { label: '编辑名字和角色…', click: () => openEditor(b).catch(report) },
    { label: '重置位置', click: () => resetPosition(b) },
    { type: 'separator' },
    ...squad ? [{ label: menuText(`小队：${squad.summary}`), enabled: false }, { label: '打开小队文件夹', click: () => openSquadFolder(b).catch(report) },
      { label: '离开小队', click: () => setSquads(leaveSquad(squads, b.id)) }]
      : [{ label: '组队：把它拖到另一只身上', enabled: false }],
    { type: 'separator' },
    { label: '删除这只桌宠…', enabled: buddies.size > 1, click: () => confirmRemove(b).catch(report) },
  ];
}
function updateTray() {
  if (quitting || !nativeAlive(tray)) return;
  const list = ordered();
  tray.setToolTip(`纸间桌宠 · ${list.length} 只 · 独立 ${PROVIDER} agent`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${anyVisible() ? '隐藏' : '显示'}全部桌宠  Ctrl+Alt+F`, click: toggleAll },
    { label: '新建桌宠…', enabled: list.length < BUDDY_LIMITS.count, click: () => openEditor(null).catch(report) },
    { type: 'separator' },
    ...list.map(b => ({ label: menuText(`${['', '− ', '= ', '≡ '][rankBars(squadView(squads, b.id, nameOf))]}${b.name} · ${PHASES[b.agent.state.phase] ?? '待命'}`), submenu: buddyMenu(b) })),
    { type: 'separator' },
    { label: '打开收纳箱', click: () => openInbox().catch(report) },
    { type: 'separator' }, { label: '退出文件桌宠', click: () => app.quit() },
  ]));
}
// 文件垫窗口不可聚焦；Windows 上借托盘弹出右键菜单，点击别处时能正常收起。
function popupMenu(b) {
  const menu = Menu.buildFromTemplate([...buddyMenu(b), { type: 'separator' }, { label: '隐藏全部桌宠', click: hideAll }]);
  if (process.platform === 'win32' && nativeAlive(tray)) tray.popUpContextMenu(menu); else menu.popup({ window: b.pet });
}
async function openInbox() {
  await mkdir(inbox(), { recursive: true }); const error = await shell.openPath(inbox()); if (error) throw new Error('暂时无法打开收纳箱');
}
async function receive(b, path) {
  if (quitting) throw new Error('文件桌宠正在退出');
  if (b.agent.busy() || b.receiving) throw new Error('正在处理当前指令，请稍等');
  b.receiving = true;
  try { await b.agent.receive(path); if (quitting) return snapshotOf(b); await showNote(b); return snapshotOf(b); }
  finally { b.receiving = false; }
}
async function command(event, data) {
  const source = sender(event); if (!payloadWithinLimit(data)) throw new Error('参数过长');
  const type = data?.type;
  if (source.kind === 'editor') {
    if (type === 'editor-save') return saveEditor(data.value);
    if (type === 'editor-cancel') { closeEditor(); return null; }
    throw new Error('设定窗口不能执行这个动作');
  }
  if (source.kind === 'linker') {
    if (type === 'link-choose') return chooseLink(data.value?.option);
    if (type === 'link-cancel') { cancelLink(); return null; }
    throw new Error('组队卡片不能执行这个动作');
  }
  const b = source.buddy, agent = b.agent;
  if (source.kind === 'pet' && !['note', 'hide', 'inbox', 'menu'].includes(type)) throw new Error('文件垫不能确认或执行动作');
  switch (type) {
    case 'note': await showNote(b); break;
    case 'hide': hideAll(); break;
    case 'menu': popupMenu(b); break;
    case 'edit': await openEditor(b); break;
    case 'close-note': if (nativeAlive(b.note)) b.note.hide(); break;
    case 'inbox': await openInbox(); break;
    case 'chat-send': if (b.receiving) throw new Error('正在接收附件'); agent.send(data.value?.text); break;
    case 'chat-summon': summon(b, data.value); break;
    case 'help-answer': settleHelp(b, data.value, 'answer'); break;
    case 'help-continue': settleHelp(b, data.value, 'continue'); break;
    case 'help-dismiss': settleHelp(b, data.value, 'dismiss'); break;
    case 'chat-approve': agent.approve(data.value); break;
    case 'chat-stop': stopTeam(b); break;
    case 'chat-reset': if (b.receiving) throw new Error('正在接收附件'); await agent.reset(); break;
    case 'attachment-remove': if (b.receiving) throw new Error('正在接收附件'); agent.removeAttachment(); break;
    default: throw new Error('未知动作');
  }
  return snapshotOf(b);
}
async function start() {
  const { entries, squads: saved } = await loadRegistry();
  createSession = SMOKE ? (await import('./buddy-smoke.mjs')).createSmokeSession
    : PROVIDER === 'DeepSeek' ? options => createDeepSeekSession(options)
    : options => createQoderSession({ root: ROOT, directory: app.getPath('userData'), ...options });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false)); session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${APP_ORIGIN}/`) && !details.url.startsWith('data:') }));
  protocol.handle('papertrail', async request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app' || !STATIC.has(url.pathname) || !['GET', 'HEAD'].includes(request.method)) return new Response('未找到资源', { status: 404 });
    try { const data = await readFile(join(ROOT, url.pathname.slice(1))); return new Response(request.method === 'HEAD' ? null : data, { headers: {
      'Content-Type': `${MIME[url.pathname.slice(url.pathname.lastIndexOf('.'))]}; charset=utf-8`,
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    } }); } catch { return new Response('未找到资源', { status: 404 }); }
  });
  const reposition = () => { for (const b of ordered()) {
    if (quitting || !nativeAlive(b.pet)) continue;
    const p = clampBuddyPosition(b.pet.getBounds(), areaFor(b.pet.getBounds())); b.pet.setPosition(p.x, p.y); positionNote(b);
  } };
  screen.on('display-removed', reposition); screen.on('display-metrics-changed', reposition);
  const respond = async work => { try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, error: error.message }; } };
  ipcMain.handle('buddy:get-state', event => respond(() => {
    const source = sender(event); return source.kind === 'editor' ? editorState() : source.kind === 'linker' ? linkState() : snapshotOf(source.buddy);
  }));
  ipcMain.handle('buddy:drop', (event, path) => respond(() => {
    const source = sender(event); if (source.kind !== 'pet' || !payloadWithinLimit(path)) throw new Error('只有文件垫可以接收文件'); return receive(source.buddy, path);
  }));
  ipcMain.handle('buddy:command', (event, data) => respond(() => command(event, data)));
  ipcMain.on('buddy:drag', (event, value) => {
    const b = ordered().find(item => trustedSender(event, item.pet, '/file-buddy.html')); if (!b || quitting) return;
    if (value === 'start') { stopWalk(b); b.dragging = { cursor: screen.getCursorScreenPoint(), origin: b.pet.getPosition(), at: Date.now() }; b.pet.moveTop(); }
    else if (value === 'end' && b.dragging) { const { origin } = b.dragging; b.dragging = null; setLinkHover(b, null); finishDrag(b, origin); }
    else if (value === 'end') b.dragging = null;
  });
  // 接近文件垫即解除穿透，以便 Windows 原生拖放进入；离开可见区域恢复穿透。
  hitTimer = setInterval(() => {
    const cursor = screen.getCursorScreenPoint();
    for (const b of buddies.values()) {
      if (!windowVisible(b.pet, quitting)) continue;
      if (b.dragging && Date.now() - b.dragging.at < 15000) {
        const p = clampBuddyPosition({ x: b.dragging.origin[0] + cursor.x - b.dragging.cursor.x, y: b.dragging.origin[1] + cursor.y - b.dragging.cursor.y }, screen.getDisplayNearestPoint(cursor).workArea); b.pet.setPosition(p.x, p.y);
        setLinkHover(b, dropTarget(b));
      } else { if (b.dragging) setLinkHover(b, null); b.dragging = null; }
      const [x, y] = b.pet.getPosition(), ignore = !b.dragging && !buddyHitTest(cursor.x - x, cursor.y - y);
      if (ignore !== b.ignoreMouse) { b.ignoreMouse = ignore; b.pet.setIgnoreMouseEvents(ignore, { forward: true }); }
    }
  }, 16);
  tray = new Tray(trayImage());
  tray.on('double-click', () => { showAll(); if (buddies.size === 1) showNote(ordered()[0]).catch(report); });
  if (!SMOKE && !globalShortcut.register('Control+Alt+F', toggleAll)) console.warn('Ctrl+Alt+F 已被占用，可使用托盘。');
  squads = saved;
  for (const entry of entries) await spawn(entry);
  updateTray();
  if (SMOKE) await smokeTest();
  else {
    showAll();
    console.log(`${PROVIDER} 便利贴桌宠已启动（${buddies.size} 只）。点击聊天，托盘可新建桌宠，Ctrl+Alt+F 显隐；认证使用本机${PROVIDER === 'DeepSeek' ? ' DEEPSEEK_API_KEY' : ' PAT'} 环境变量，原文件不动。`);
  }
}
async function smokeTest() {
  const { runBuddySmoke, runMultiBuddySmoke, runSquadSmoke, runDispatchSmoke, runSummonSmoke } = await import('./buddy-smoke.mjs');
  const first = ordered()[0];
  const flush = async () => { clearTimeout(registryTimer); await persistRegistry(); return readFile(join(app.getPath('userData'), 'buddies.json'), 'utf8'); };
  await runBuddySmoke({ ROOT, pet: first.pet, getNote: () => first.note, showNote: () => showNote(first), receive: path => receive(first, path),
    snapshot: () => snapshotOf(first), diagnostic, inbox: inbox() });
  await runMultiBuddySmoke({ first, list: ordered, getEditor: () => editor, openEditor, showNote, snapshotOf, removeBuddy, diagnostic, flush });
  // 模拟松手：把拖动的那只移到对方身上，走和真实拖动结束同一条路径。
  const drop = (a, b) => { const origin = a.pet.getPosition(), [x, y] = b.pet.getPosition(); a.pet.setPosition(x + 10, y + 10); finishDrag(a, origin); return origin; };
  const hover = (a, b) => { if (b) { const [x, y] = b.pet.getPosition(); a.pet.setPosition(x + 10, y + 10); } setLinkHover(a, b ? dropTarget(a) : null); };
  await runSquadSmoke({ first, list: ordered, create: saveEditor, drop, hover, getLinker: () => nativeAlive(linker) ? linker : null, getSquads: () => squads,
    showNote, removeBuddy, leave: b => setSquads(leaveSquad(squads, b.id)), diagnostic, flush });
  const setTeam = (lead, members) => {
    const squad = { id: randomUUID(), color: nextSquadColor([]), lead: lead.id, members: [lead.id, ...members.map(m => m.id)] }; setSquads([squad]); return squad;
  };
  await runDispatchSmoke({ first, list: ordered, setTeam, clearTeam: () => setSquads([]), showNote, snapshotOf, inbox: inbox(), diagnostic });
  await runSummonSmoke({ first, list: ordered, setTeam, clearTeam: () => setSquads([]), showNote, snapshotOf, inbox: inbox(), diagnostic });
  const probe = await createQoderSession({ root: ROOT, directory: app.getPath('userData'), probe: true,
    onEvent: () => {}, onTool: () => { throw new Error('离线检查不执行工具'); } });
  console.log(JSON.stringify({ qoderSdkHost: 'passed', ...probe.metadata, modelRequestSent: false }));
  await probe.close();
  const windows = ordered().flatMap(b => { stopWalk(b); clearTimeout(b.bubbleTimer); return [b.pet, b.note, b.bubble]; }).filter(Boolean);
  for (const window of windows) if (nativeAlive(window)) window.destroy();
  if (nativeAlive(editor)) editor.destroy();
  if (nativeAlive(linker)) linker.destroy();
  await new Promise(resolve => setTimeout(resolve, 150));
  app.once('will-quit', () => console.log(JSON.stringify({ fileBuddyShutdown: 'passed', destroyedWindows: windows.every(window => window.isDestroyed()), timerStopped: hitTimer === null })));
  app.quit();
}
if (!locked) app.quit();
else {
  app.on('second-instance', () => showAll()); app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    quitting = true; stopInteractions();
    if (registryFlushed) return;
    event.preventDefault(); Promise.all([persistRegistry(), ...ordered().map(b => b.agent.dispose())]).finally(() => { registryFlushed = true; app.quit(); });
  });
  app.on('will-quit', stopInteractions);
  app.whenReady().then(start).catch(error => { console.error(error); if (!SMOKE) dialog.showErrorBox('文件桌宠启动失败', error.message); app.exit(1); });
}
