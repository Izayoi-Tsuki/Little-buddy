import { drawCharacter, drawHeart } from './scene.mjs';
import { BUDDY_LAYOUT as L, FILE_CATEGORIES, PHASES, buddyCharacter } from './file-buddy.mjs';
import { drawRank, rankBars } from './buddy-rank.mjs';
const bridge = window.fileBuddy, $ = id => document.getElementById(id);
let character = buddyCharacter(null);
let state = { phase: 'idle', revision: -1, file: null }, over = false, linkOver = false, dropPending = false, enterDepth = 0;
let visible = !document.hidden, frameId = null, lastFrame = 0, receiveAt = -Infinity, pressed = null, errorTimer;
// 小动作：love 爱心眼、shake 抖一抖、walk 走路时小跳、report 向用户汇报时举手跳一跳并冒感叹号、
// help 停下来求助时举手跳一跳并冒问号；值为截止时间。等用户决定期间头顶一直挂着不跳的问号。
const emotes = {};
const emoting = time => Object.keys(emotes).filter(kind => emotes[kind] > time);
const busy = () => ['working', 'confirming', 'stopping'].includes(state.phase);
const box = (ctx, x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), w, h); };
function error(e) {
  $('buddy-error').textContent = e.message ?? String(e); $('buddy-error').hidden = false;
  $('buddy-body').title = $('buddy-error').textContent;
  clearTimeout(errorTimer); errorTimer = setTimeout(() => { $('buddy-error').hidden = true; }, 6000);
}
function drawFile(ctx) {
  if (!state.file) return;
  const color = FILE_CATEGORIES[state.file.category] ?? FILE_CATEGORIES.其他;
  ctx.save(); ctx.translate(L.file.x, L.file.y); ctx.scale(.4, .4);
  const x = 0, y = 0;
  box(ctx, x - 15, y - 24, 29, 33, '#67755a'); box(ctx, x - 13, y - 22, 25, 29, '#faf4dc');
  box(ctx, x - 10, y - 19, 19, 7, color); box(ctx, x - 8, y - 8, 15, 2, '#a4ae8d'); box(ctx, x - 8, y - 3, 11, 2, '#a4ae8d');
  box(ctx, x + 5, y - 24, 9, 8, '#c4ccb0'); box(ctx, x + 8, y - 22, 6, 6, '#e6e9d2');
  if (state.phase === 'done') { box(ctx, x + 12, y - 8, 15, 15, '#86a16c'); ctx.fillStyle = '#fff8df'; ctx.font = '13px monospace'; ctx.fillText('✓', x + 14, y + 4); }
  if (state.phase === 'failed') { box(ctx, x + 12, y - 8, 15, 15, '#bf876a'); ctx.fillStyle = '#fff8df'; ctx.font = '13px monospace'; ctx.fillText('!', x + 17, y + 4); }
  ctx.restore();
}
function drawAlert(ctx, x, y, mark = '!') {
  box(ctx, x, y, 9, 13, '#6b5a3e'); box(ctx, x + 1, y + 1, 7, 11, '#fff4bd');
  if (mark === '!') { box(ctx, x + 3, y + 2, 3, 6, '#d0573f'); box(ctx, x + 3, y + 9, 3, 2, '#d0573f'); return; }
  const blue = '#4a78a8';
  box(ctx, x + 2, y + 2, 5, 2, blue); box(ctx, x + 5, y + 4, 2, 2, blue); box(ctx, x + 3, y + 6, 3, 2, blue); box(ctx, x + 3, y + 9, 3, 2, blue);
}
function paint(time) {
  const ctx = $('buddy-canvas').getContext('2d'); ctx.clearRect(0, 0, L.width, L.height); ctx.imageSmoothingEnabled = false;
  if (over || linkOver) box(ctx, L.mat.x, L.mat.y, L.mat.width, L.mat.height, '#dce8c950');
  // 小队成员左上角挂同色军衔：带队三道杠、成员一道杠、同伴两道杠。
  const squad = state.buddy?.squad;
  if (squad) drawRank(ctx, 3, 2, rankBars(squad), squad.color);
  const active = emoting(time), love = active.includes('love'), asking = active.includes('help'), alert = asking || active.includes('report');
  if (active.length) document.body.dataset.emote = active.at(-1); else delete document.body.dataset.emote;
  const greet = over || time - receiveAt < 700;
  const pose = { action: state.phase === 'working' ? 'read' : 'idle', activityVisual: true,
    gesture: greet || alert, jobId: greet && state.file ? 'received' : null, eyes: love ? 'heart' : null,
    status: state.phase === 'failed' ? 'failed' : over || state.phase === 'confirming' ? 'unknown' : 'idle' };
  const dx = active.includes('shake') ? [0, 2, 0, -2][Math.floor(time / 50) % 4] : 0;
  const dy = active.includes('walk') ? -(Math.floor(time / 120) % 2) * 2 : alert ? -[0, 2, 4, 2][Math.floor(time / 90) % 4] : 0;
  drawCharacter(ctx, L.home.x + dx, L.home.y + dy, character, pose, time, 1.25);
  if (love) { ctx.save(); ctx.translate(48, 15 - (time % 900) / 150); ctx.scale(1.25, 1.25); drawHeart(ctx, 0, 0); ctx.restore(); }
  if (alert) drawAlert(ctx, 50, 3 + dy / 2, asking ? '?' : '!');
  else if (state.waiting) drawAlert(ctx, 50, 3, '?');
  drawFile(ctx);
}
function loop(time) {
  frameId = null; if (!visible || document.hidden) return;
  const active = over || state.phase === 'working' || time - receiveAt < 700 || emoting(time).length > 0;
  if (time - lastFrame >= 1000 / (active ? 24 : 4)) { paint(time); lastFrame = time; }
  frameId = requestAnimationFrame(loop);
}
function resume() {
  if (frameId != null) cancelAnimationFrame(frameId); frameId = null;
  paint(performance.now()); if (visible && !document.hidden) frameId = requestAnimationFrame(loop);
}
function update(data) {
  if (!data || data.revision < state.revision) return;
  const now = performance.now();
  if (data.file && data.file.path !== state.file?.path) receiveAt = now;
  state = data; character = buddyCharacter(data.buddy?.look);
  const name = data.buddy?.name ?? '';
  // 待命和已回复时显示名字，便于区分多只桌宠；在等用户回答求助时显示「等你决定」；其余阶段显示状态。
  const idle = ['idle', 'done'].includes(state.phase);
  $('buddy-status').textContent = over ? '放给我' : linkOver ? '松手组队' : idle && data.waiting ? '等你决定' : name && idle ? name : PHASES[state.phase] ?? '聊一聊';
  $('buddy-status').dataset.state = state.phase;
  $('file-name').textContent = state.file?.name ?? '拖一个文件给我'; $('file-name').title = state.file?.name ?? '';
  $('mat-hint').textContent = '点击聊天 · 原文件不动';
  const who = name ? `${name} · ` : '', squadText = data.buddy?.squad ? ` · 小队：${data.buddy.squad.summary}` : '';
  $('buddy-body').title = state.error || (state.file ? `${who}附件：${state.file.name} · 点击聊天${squadText}` : `${who}点击聊天 · 拖文件给我 · 拖到另一只身上组队 · 右键更多${squadText}`);
  $('file-mat').classList.toggle('is-busy', busy()); $('file-mat').classList.toggle('is-over', over || linkOver); resume();
}
function setOver(value) { over = value; update(state); }
const hasFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files');
// 页面禁止默认导航和原生文件移动，只在文件垫接受一个真实 File。
document.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; });
document.addEventListener('drop', event => { event.preventDefault(); setOver(false); enterDepth = 0; });
const mat = $('file-mat');
mat.addEventListener('dragenter', event => { if (!hasFiles(event)) return; event.preventDefault(); enterDepth++; setOver(true); });
mat.addEventListener('dragleave', () => { enterDepth = Math.max(0, enterDepth - 1); if (!enterDepth) setOver(false); });
mat.addEventListener('dragover', event => {
  event.preventDefault(); event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = hasFiles(event) && !busy() && !dropPending ? 'copy' : 'none';
});
mat.addEventListener('drop', async event => {
  event.preventDefault(); event.stopPropagation(); enterDepth = 0; setOver(false);
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length !== 1) return error(new Error('请一次只放一个文件，暂不支持文件夹'));
  if (dropPending || busy()) return error(new Error('正在处理当前指令，请稍等'));
  if (!bridge) return error(new Error('请通过桌面入口启动'));
  dropPending = true;
  try { update(await bridge.drop(files[0])); } catch (e) { error(e); } finally { dropPending = false; }
});
if (!bridge) { $('browser-warning').hidden = false; paint(0); }
else {
  bridge.onState(update); bridge.onVisibility(value => { visible = value; resume(); }); bridge.getState().then(update).catch(error);
  bridge.onLinkTarget(value => { linkOver = !!value; update(state); });
  bridge.onEmote(value => {
    if (!value?.kind) return; emotes[value.kind] = performance.now() + Math.min(5000, Math.max(0, value.ms ?? 1200));
    document.body.dataset.emote = value.kind; resume();
  });
  const note = () => bridge.command('note').catch(error);
  $('buddy-status').addEventListener('click', note); mat.addEventListener('click', note);
  $('buddy-body').addEventListener('click', event => event.stopPropagation());
  mat.addEventListener('keydown', event => { if (event.key === 'Enter') note(); });
  $('buddy-body').addEventListener('pointerdown', event => {
    if (event.button !== 0) return; pressed = { x: event.screenX, y: event.screenY, pointer: event.pointerId, moved: false };
    $('buddy-body').setPointerCapture(event.pointerId); bridge.dragStart();
  });
  $('buddy-body').addEventListener('pointermove', event => { if (pressed && Math.hypot(event.screenX - pressed.x, event.screenY - pressed.y) > 5) pressed.moved = true; });
  $('buddy-body').addEventListener('pointerup', event => {
    if (!pressed) return; const click = !pressed.moved; pressed = null; bridge.dragEnd();
    if ($('buddy-body').hasPointerCapture(event.pointerId)) $('buddy-body').releasePointerCapture(event.pointerId); if (click) note();
  });
  const endDrag = () => { if (pressed) { pressed = null; bridge.dragEnd(); } };
  $('buddy-body').addEventListener('lostpointercapture', endDrag); $('buddy-body').addEventListener('pointercancel', endDrag);
  document.addEventListener('contextmenu', event => { event.preventDefault(); bridge.command('menu').catch(error); });
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; setOver(false); resume(); });
  window.addEventListener('pagehide', () => { if (frameId != null) cancelAnimationFrame(frameId); clearTimeout(errorTimer); endDrag(); });
}
