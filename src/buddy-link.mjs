import { SQUAD_COLORS, buddyCharacter } from './file-buddy.mjs';
import { drawCharacter, drawHeart } from './scene.mjs';
const bridge = window.fileBuddy, $ = id => document.getElementById(id);
let pending = false;
function error(e) { $('link-error').textContent = e?.message ?? String(e); $('link-error').hidden = false; }
// 预览：拖过来的在左，被拖到的在右，中间一颗小队颜色的像素爱心。
function preview(data) {
  const ctx = $('link-preview').getContext('2d'); ctx.clearRect(0, 0, 160, 52); ctx.imageSmoothingEnabled = false;
  drawCharacter(ctx, 26, 27, buddyCharacter(data.dragged.look), { action: 'idle', status: 'idle' }, 0, 1.2);
  drawCharacter(ctx, 134, 27, buddyCharacter(data.target.look), { action: 'idle', status: 'idle' }, 0, 1.2);
  if (data.options.length) { ctx.save(); ctx.translate(70, 18); ctx.scale(4, 4); drawHeart(ctx, 0, 0, (SQUAD_COLORS[data.color] ?? SQUAD_COLORS.steel).main); ctx.restore(); }
}
function fill(data) {
  if (!data?.dragged) return;
  $('link-title').textContent = data.title; document.title = data.title;
  $('link-note').textContent = data.note; $('link-note').hidden = !data.note; $('link-error').hidden = true;
  const list = $('link-options'); list.replaceChildren();
  for (const option of data.options) {
    const button = document.createElement('button'), label = document.createElement('strong'), hint = document.createElement('span');
    button.type = 'button'; button.className = 'option'; button.dataset.option = option.id;
    label.textContent = option.label; hint.textContent = option.hint; button.title = `${option.label} · ${option.hint}`;
    button.append(label, hint); button.addEventListener('click', () => command('link-choose', { option: option.id })); list.append(button);
  }
  $('link-cancel').textContent = data.options.length ? '取消' : '知道了';
  preview(data); (list.querySelector('button') ?? $('link-cancel')).focus();
}
async function command(type, value) {
  if (!bridge || pending) return;
  pending = true; for (const button of document.querySelectorAll('button')) button.disabled = true; $('link-error').hidden = true;
  try { await bridge.command(type, value); } catch (e) { error(e); } finally { pending = false; for (const button of document.querySelectorAll('button')) button.disabled = false; }
}
for (const id of ['link-cancel', 'link-close']) $(id).addEventListener('click', () => command('link-cancel'));
document.addEventListener('keydown', event => { if (event.key === 'Escape') void command('link-cancel'); });
document.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; });
document.addEventListener('drop', event => event.preventDefault());
if (bridge) { bridge.onLink(fill); bridge.getState().then(fill).catch(error); }
else $('browser-warning').hidden = false;
