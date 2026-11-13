// 文件桌宠的纯逻辑：布局、文件分类、安全命名、输出规划和任务状态机。主进程与渲染页共用，不依赖 Node。
const rect = (x, y, width, height) => Object.freeze({ x, y, width, height });
export const BUDDY_LAYOUT = Object.freeze({ width: 80, height: 88,
  label: rect(6, 67, 68, 18),
  home: Object.freeze({ x: 38, y: 39 }),
  file: Object.freeze({ x: 61, y: 52 }),
  mat: rect(10, 9, 60, 55),
  hitRects: Object.freeze([rect(6, 67, 68, 18), rect(10, 9, 60, 55)]),
});
export const NOTE_SIZE = Object.freeze({ width: 340, height: 430 });
export const EDITOR_SIZE = Object.freeze({ width: 300, height: 420 });

// 每只桌宠的外观与设定：颜色映射到像素调色板，造型映射到人形/小怪兽与发型。
export const BUDDY_COLORS = Object.freeze({ green: { label: '青绿', palette: 'OpenAI', swatch: '#6b9474' }, orange: { label: '暖橙', palette: 'Anthropic', swatch: '#c6946d' },
  blue: { label: '湖蓝', palette: 'Google', swatch: '#7395ac' }, purple: { label: '淡紫', palette: 'generic', swatch: '#a39baa' } });
export const BUDDY_STYLES = Object.freeze({ short: { label: '短发', form: 'human', gender: 'neutral' }, long: { label: '长发', form: 'human', gender: 'feminine' },
  dark: { label: '深色短发', form: 'human', gender: 'masculine' }, mascot: { label: '小怪兽', form: 'mascot', gender: 'neutral' } });
export const BUDDY_LIMITS = Object.freeze({ name: 12, role: 300, count: 8 });
// 小队军衔颜色：8 只桌宠最多组成 4 支小队，每支一种颜色。
export const SQUAD_COLORS = Object.freeze({ steel: { label: '铁灰', light: '#b9c1c9', main: '#7f8a96', dark: '#4f5862' }, copper: { label: '铜色', light: '#e2a77c', main: '#b8733f', dark: '#7a4824' },
  gold: { label: '金色', light: '#f0d27a', main: '#c99c2e', dark: '#856316' }, rose: { label: '玫瑰', light: '#e3a5bd', main: '#b0607f', dark: '#743a51' } });
const plainText = value => String(value ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '');
// 名字为单行短文本；角色可多行但有长度上限；外观只接受已知选项，未知值回落为默认。
export function sanitizeBuddyProfile(input) {
  const name = plainText(input?.name).replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('请给桌宠起个名字');
  if ([...name].length > BUDDY_LIMITS.name) throw new Error(`名字不能超过 ${BUDDY_LIMITS.name} 个字`);
  const role = plainText(input?.role).replace(/\x0a{3,}/g, '\x0a\x0a').trim();
  if ([...role].length > BUDDY_LIMITS.role) throw new Error(`角色设定不能超过 ${BUDDY_LIMITS.role} 个字`);
  const color = Object.hasOwn(BUDDY_COLORS, input?.look?.color) ? input.look.color : 'green';
  const style = Object.hasOwn(BUDDY_STYLES, input?.look?.style) ? input.look.style : 'short';
  return { name, role, look: { color, style } };
}
export function buddyCharacter(look) {
  const style = BUDDY_STYLES[look?.style] ?? BUDDY_STYLES.short;
  return { provider: (BUDDY_COLORS[look?.color] ?? BUDDY_COLORS.green).palette, form: style.form, gender: style.gender };
}
export function buddyHitTest(x, y) {
  return BUDDY_LAYOUT.hitRects.some(r => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
}
export function clampBuddyPosition(position, area, size = BUDDY_LAYOUT) {
  const x = Number.isFinite(position?.x) ? position.x : area.x + area.width - size.width - 16;
  const y = Number.isFinite(position?.y) ? position.y : area.y + area.height - size.height - 8;
  return { x: Math.round(Math.max(area.x, Math.min(area.x + Math.max(0, area.width - size.width), x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + Math.max(0, area.height - size.height), y))) };
}
// 便利贴优先贴在桌宠左上方；左侧放不下时贴到右侧，始终限制在同一块屏幕工作区内。
export function notePosition(buddy, area, size = NOTE_SIZE) {
  let x = buddy.x - size.width + 18;
  if (x < area.x) x = buddy.x + buddy.width - 18;
  return clampBuddyPosition({ x, y: buddy.y + buddy.height - size.height - 70 }, area, size);
}
// 斜杠召唤：「/乙 要说的话」或「/乙要说的话」。名字可能含空格，按最长的已知名字匹配；
// 对不上时取第一段非空白作名字，known 为 false。不是「/」紧跟非空白开头的文字返回 null。
export const SUMMON_LIMIT = 2000;
export function parseSummon(input, names = []) {
  const value = String(input ?? '');
  if (!/^\/\S/.test(value)) return null;
  const body = value.slice(1);
  const name = [...names].filter(Boolean).sort((a, b) => b.length - a.length).find(n => body.startsWith(n));
  if (name) return { to: name, text: body.slice(name.length).trim(), known: true };
  const to = body.match(/^\S+/)[0];
  return { to, text: body.slice(to.length).trim(), known: false };
}
// 同伴回话时用开头的「@对象」选择说给谁：@用户 是直接对用户说或汇报，「@用户 求助」是卡住了请用户决定，@对方名字或没写都是回给对方。
// 只认这两个名字并去掉标记；模型偶尔把标记写进「」或【】里，一并去掉。
export const USER_TARGET = '用户';
export function parseReplyTarget(input, peer = '') {
  const value = String(input ?? '').trim(), head = value.match(/^[「【\[]?\s*[@＠]\s*/)?.[0];
  if (!head) return { to: 'peer', text: value };
  const rest = value.slice(head.length), name = [USER_TARGET, peer].filter(Boolean).sort((a, b) => b.length - a.length).find(n => rest.startsWith(n));
  if (!name) return { to: 'peer', text: value };
  const text = rest.slice(name.length).replace(/^[」】\]]?[\s:：，,]*/, '').trim();
  const help = name === USER_TARGET && text.match(/^[「【\[]?求助[」】\]]?[\s:：，,]*/)?.[0];
  if (help) return { to: 'help', text: text.slice(help.length).trim() };
  return { to: name === USER_TARGET ? 'user' : 'peer', text };
}
// 同伴来回对话的门控：聊满 TALK_ROUNDS 句、和之前的话高度重复、双方连着反问，都停下来找用户。
// talk 记着发起召唤的那只、随话的附件、第几句、话题和最近说过的话。
export const TALK_ROUNDS = 4;
export const TALK_GATES = { help: '主动求助', rounds: `聊满 ${TALK_ROUNDS} 句还没有结果`, repeat: '在重复差不多的话', questions: '在互相反问' };
function bigrams(text) {
  const s = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, ''), set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}
export function similarity(a, b) {
  const x = bigrams(a), y = bigrams(b); if (!x.size || !y.size) return 0;
  let same = 0; for (const gram of x) if (y.has(gram)) same++;
  return same / (x.size + y.size - same);
}
export const isQuestion = text => /(?:[?？]|[吗呢么嘛][\s。.…~～]*)$/.test(String(text ?? '').trim());
export function openTalk(text, fields = {}) {
  return { ...fields, round: 1, topic: String(text).slice(0, 80), history: [String(text)], repeats: 0, questions: isQuestion(text) ? 1 : 0 };
}
// 收到一句回给对方的话：返回更新后的 talk，以及应停下来的原因（不用停时为 null）。
// 一句和之前几乎一样，或连着两句都和之前差不多，算重复；连着三句都是问句，算互相反问。
export function talkGate(talk, text) {
  const history = talk.history ?? [], top = Math.max(0, ...history.map(said => similarity(said, text)));
  const repeats = top >= .6 ? (talk.repeats ?? 0) + 1 : 0, questions = isQuestion(text) ? (talk.questions ?? 0) + 1 : 0;
  const next = { ...talk, history: [...history, String(text)].slice(-8), repeats, questions };
  const reason = top >= .85 || repeats >= 2 ? 'repeat' : questions >= 3 ? 'questions' : talk.round >= TALK_ROUNDS ? 'rounds' : null;
  return { reason, talk: next };
}

const CATEGORY_EXTENSIONS = {
  图片: 'png jpg jpeg gif bmp webp svg ico heic tif tiff psd',
  文档: 'pdf doc docx txt md rtf odt wps log',
  表格: 'xls xlsx csv ods et tsv',
  演示: 'ppt pptx key odp dps',
  压缩包: 'zip rar 7z tar gz tgz bz2 xz',
  代码: 'js mjs cjs ts tsx jsx py java c cpp h hpp cs go rs rb php html htm css json xml yml yaml toml ini sh ps1 bat cmd sql',
  音频: 'mp3 wav flac aac ogg m4a',
  视频: 'mp4 mov avi mkv webm wmv',
  快捷方式: 'lnk url',
};
const EXTENSION_CATEGORY = new Map(Object.entries(CATEGORY_EXTENSIONS).flatMap(([category, list]) => list.split(' ').map(ext => [`.${ext}`, category])));
export const FILE_CATEGORIES = Object.freeze({
  图片: '#7da7b8', 文档: '#e8e1c4', 表格: '#8fb27b', 演示: '#d99a6c', 压缩包: '#c7a76a',
  代码: '#8c95b8', 音频: '#b48fb0', 视频: '#a07f9b', 快捷方式: '#a3b0a7', 其他: '#c9c8b8',
});
const TEXT_EXTENSIONS = new Set('.txt .md .csv .tsv .log .json .xml .yml .yaml .toml .ini .js .mjs .cjs .ts .tsx .jsx .py .java .c .cpp .h .hpp .cs .go .rs .rb .php .html .htm .css .sh .ps1 .bat .cmd .sql'.split(' '));

export function baseName(path) { return String(path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''; }
export function splitName(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}
export function classifyFile(name) { return EXTENSION_CATEGORY.get(splitName(name).ext.toLowerCase()) ?? '其他'; }
export function isTextFile(name) { return TEXT_EXTENSIONS.has(splitName(name).ext.toLowerCase()); }
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB']; let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export const NAME_LIMIT = 120;
// 用户输入的新名字只能是单个文件名：去掉路径分隔和系统非法字符，并始终保留原扩展名，避免改变文件类型。
export function sanitizeFileName(input, originalExt = '') {
  let name = String(input ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').trim().replace(/[. ]+$/, '');
  if (!name) throw new Error('请输入新的文件名');
  if (originalExt && !name.toLowerCase().endsWith(originalExt.toLowerCase())) name += originalExt;
  if ([...name].length > NAME_LIMIT) throw new Error(`文件名不能超过 ${NAME_LIMIT} 个字符`);
  if (RESERVED.test(name)) throw new Error('这是 Windows 保留名称，请换一个名字');
  return name;
}
// 同名时依次尝试“名字 (2).扩展名”，主进程以独占方式创建，绝不覆盖已有文件。
export function candidateName(name, attempt) {
  if (attempt <= 1) return name;
  const { stem, ext } = splitName(name);
  return `${stem} (${attempt})${ext}`;
}

export const BUDDY_ACTIONS = Object.freeze([
  Object.freeze({ id: 'inspect', label: '查看信息', hint: '只读取名称、大小和时间', writes: false, prop: 'read' }),
  Object.freeze({ id: 'copy', label: '复制到收纳箱', hint: '在收纳箱保存一份副本', writes: true, prop: 'copy' }),
  Object.freeze({ id: 'archive', label: '按类型归档副本', hint: '按类型和月份存放副本', writes: true, prop: 'move' }),
  Object.freeze({ id: 'rename', label: '重命名另存', hint: '用新名字另存一份副本', writes: true, prop: 'rename' }),
  Object.freeze({ id: 'reveal', label: '打开所在文件夹', hint: '在资源管理器中选中原文件', writes: false, prop: 'read' }),
]);
export const actionById = id => BUDDY_ACTIONS.find(action => action.id === id);

// 返回相对收纳箱的目录段与文件名；主进程负责拼接根目录并实际写入。
export function outputPlan(actionId, file, { now = new Date(), newName } = {}) {
  if (actionId === 'copy') return { folder: ['收纳'], name: file.name };
  if (actionId === 'archive') {
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return { folder: ['归档', classifyFile(file.name), month], name: file.name };
  }
  if (actionId === 'rename') return { folder: ['重命名'], name: sanitizeFileName(newName, splitName(file.name).ext) };
  throw new Error('该动作不会生成副本');
}

export const PHASES = Object.freeze({ idle: '聊一聊', asking: '附件已收', confirming: '待确认', working: '思考中', stopping: '停止中', done: '已回复', failed: '出错了' });
export function createBuddyState() {
  return { phase: 'idle', revision: 0, file: null, action: null, plan: null, result: null, error: '' };
}
const ALLOWED = {
  receive: ['idle', 'asking', 'confirming', 'done', 'failed'],
  choose: ['asking'], back: ['confirming', 'failed'], confirm: ['confirming'],
  succeed: ['working'], fail: ['working'], again: ['done', 'failed'],
  dismiss: ['idle', 'asking', 'confirming', 'done', 'failed'],
};
// 只有合法的阶段转换会产生新状态；工作中不能换文件或关闭，避免结果与文件错位。
export function buddyTransition(state, event) {
  const type = event?.type;
  if (!ALLOWED[type]?.includes(state.phase)) throw new Error(state.phase === 'working' ? '正在处理当前文件，请稍等' : '当前不能执行这个操作');
  const next = { ...state, revision: state.revision + 1 };
  switch (type) {
    case 'receive': return { ...next, phase: 'asking', file: event.file, action: null, plan: null, result: null, error: '' };
    case 'choose': {
      const action = actionById(event.action);
      if (!action) throw new Error('未知动作');
      return { ...next, phase: action.writes ? 'confirming' : 'working', action: action.id, plan: event.plan ?? null, error: '' };
    }
    case 'back': return { ...next, phase: 'asking', action: null, plan: null, error: '' };
    case 'confirm': return { ...next, phase: 'working' };
    case 'succeed': return { ...next, phase: 'done', result: event.result ?? null };
    case 'fail': return { ...next, phase: 'failed', error: String(event.error || '未知错误') };
    case 'again': return { ...next, phase: 'asking', action: null, plan: null, result: null, error: '' };
    case 'dismiss': return { ...createBuddyState(), revision: next.revision };
    default: throw new Error('未知事件');
  }
}
