import { BUDDY_COLORS, BUDDY_STYLES, BUDDY_LIMITS, buddyCharacter } from './file-buddy.mjs';
import { drawCharacter } from './scene.mjs';
const bridge = window.fileBuddy, $ = id => document.getElementById(id);
let current = null, pending = false;
function choices(container, name, options, decorate) {
  for (const [value, option] of Object.entries(options)) {
    const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
    label.className = 'choice'; input.type = 'radio'; input.name = name; input.value = value; text.textContent = option.label;
    label.append(input); decorate?.(label, option); label.append(text); container.append(label);
  }
}
choices($('edit-colors'), 'color', BUDDY_COLORS, (label, option) => {
  const dot = document.createElement('span'); dot.className = 'dot'; dot.style.setProperty('--swatch', option.swatch); label.append(dot);
});
choices($('edit-styles'), 'style', BUDDY_STYLES);
const picked = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
const look = () => ({ color: picked('color'), style: picked('style') });
function preview() {
  const ctx = $('edit-preview').getContext('2d'); ctx.clearRect(0, 0, 72, 72); ctx.imageSmoothingEnabled = false;
  drawCharacter(ctx, 36, 44, buddyCharacter(look()), { action: 'idle', status: 'idle' }, 0, 1.6);
}
function count() { $('edit-count').textContent = `${[...$('edit-role').value].length} / ${BUDDY_LIMITS.role}`; }
function error(e) { $('edit-error').textContent = e?.message ?? String(e); $('edit-error').hidden = false; }
function fill(data) {
  if (!data?.profile) return;
  current = data; const { profile, mode, provider } = data, editing = mode === 'edit';
  $('edit-title').textContent = editing ? `编辑「${profile.name}」` : '新建桌宠'; document.title = $('edit-title').textContent;
  $('edit-name').value = profile.name; $('edit-role').value = profile.role ?? '';
  for (const [name, value] of [['color', profile.look?.color], ['style', profile.look?.style]]) {
    const input = document.querySelector(`input[name="${name}"][value="${value}"]`) ?? document.querySelector(`input[name="${name}"]`); input.checked = true;
  }
  $('edit-provider').textContent = `独立 ${provider} 会话 · 不继承其他桌宠的对话`;
  $('edit-hint').textContent = editing ? '名字和外观立即生效；角色设定从下一次「新对话」开始生效。' : '每只桌宠有自己的便利贴和对话，共用同一个收纳箱。';
  $('edit-save').textContent = editing ? '保存' : '创建'; $('edit-error').hidden = true;
  count(); preview(); $('edit-name').focus(); $('edit-name').select();
}
async function command(type, value) {
  if (!bridge || pending) return;
  pending = true; $('edit-save').disabled = true; $('edit-error').hidden = true;
  try { await bridge.command(type, value); } catch (e) { error(e); } finally { pending = false; $('edit-save').disabled = false; }
}
$('edit-form').addEventListener('submit', event => {
  event.preventDefault(); if (!current) return;
  void command('editor-save', { name: $('edit-name').value, role: $('edit-role').value, look: look() });
});
$('edit-form').addEventListener('change', preview);
$('edit-role').addEventListener('input', count);
for (const id of ['edit-cancel', 'edit-close']) $(id).addEventListener('click', () => command('editor-cancel'));
document.addEventListener('keydown', event => { if (event.key === 'Escape') void command('editor-cancel'); });
document.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'; });
document.addEventListener('drop', event => event.preventDefault());
if (bridge) { bridge.onEdit(fill); bridge.getState().then(fill).catch(error); }
else $('browser-warning').hidden = false;
