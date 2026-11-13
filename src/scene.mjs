import { OFFICE_LAYOUT, TEAM_MODULE } from './office-layout.mjs';
export { OFFICE_LAYOUT, packetRoute, packetFrame, pointOnPath } from './office-layout.mjs';

const PALETTES = {
  OpenAI: { main: '#6b9474', light: '#b9d3a6', dark: '#3e5f49', body: '#e4eed4' },
  Anthropic: { main: '#c6946d', light: '#eed3a7', dark: '#8a614c', body: '#f2dfb8' },
  Google: { main: '#7395ac', light: '#c2d7df', dark: '#456675', body: '#e0e8dc' },
  generic: { main: '#a39baa', light: '#d9d1df', dark: '#6d677a', body: '#ece5ed' },
};
function rect(ctx, x, y, width, height, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
}
function polygon(ctx, points, fill, stroke) {
  ctx.beginPath();
  points.forEach(([x, y], index) => index ? ctx.lineTo(Math.round(x), Math.round(y)) : ctx.moveTo(Math.round(x), Math.round(y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
}
function text(ctx, label, x, y, color = '#738565', size = 8, align = 'left') {
  ctx.font = `${size}px monospace`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(label, Math.round(x), Math.round(y));
}
function frontBox(ctx, x, y, width, depth, height, colors) {
  rect(ctx, x + 3, y + depth + height, width, 3, '#65725422');
  rect(ctx, x, y, width, depth + height, colors[2]);
  rect(ctx, x + 1, y + 1, width - 2, depth - 1, colors[0]);
  rect(ctx, x + 1, y + depth, width - 2, height - 1, colors[1]);
  rect(ctx, x + 2, y + 1, width - 4, 1, '#f5f3d870');
}
function plant(ctx, x, y, scale = 1) {
  ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
  rect(ctx, -8, -3, 17, 13, '#aa8c69'); rect(ctx, -10, -6, 21, 6, '#ceb18a');
  rect(ctx, -4, -29, 7, 26, '#6c8357'); rect(ctx, -13, -24, 9, 13, '#859c66');
  rect(ctx, 3, -34, 9, 17, '#96aa70'); rect(ctx, -7, -40, 9, 17, '#a0b97d');
  rect(ctx, 5, -19, 12, 6, '#6e8c59'); rect(ctx, -15, -18, 8, 6, '#9eb879');
  ctx.restore();
}
function paper(ctx, x, y, color = '#f2f1d9', marked = false) {
  rect(ctx, x + 2, y + 2, 14, 17, '#7d8b6866'); rect(ctx, x, y, 13, 16, '#89977a');
  rect(ctx, x + 1, y + 1, 11, 14, color); rect(ctx, x + 3, y + 5, 6, 1, '#a2ad8d');
  rect(ctx, x + 3, y + 8, 7, 1, '#a2ad8d'); rect(ctx, x + 3, y + 11, 4, 1, marked ? '#b97962' : '#a2ad8d');
}
// 5×4 像素爱心，用作爱心眼和头顶冒出的小爱心。
export const HEART_COLOR = '#e05a73';
export function drawHeart(ctx, x, y, color = HEART_COLOR) {
  rect(ctx, x + 1, y, 1, 1, color); rect(ctx, x + 3, y, 1, 1, color);
  rect(ctx, x, y + 1, 5, 1, color); rect(ctx, x + 1, y + 2, 3, 1, color); rect(ctx, x + 2, y + 3, 1, 1, color);
}
function book(ctx, x, y, color) {
  polygon(ctx, [[x, y], [x + 8, y + 2], [x + 16, y], [x + 16, y + 11], [x + 8, y + 13], [x, y + 11]], '#fff6d9', color);
  rect(ctx, x + 8, y + 2, 1, 10, color);
  rect(ctx, x + 2, y + 4, 4, 1, '#b7b69c'); rect(ctx, x + 10, y + 6, 4, 1, '#b7b69c');
}
function actionProp(ctx, action, x, y, tick, palette, form) {
  if (action === 'idle') return;
  const shift = tick % 2;
  if (action === 'read') {
    book(ctx, x - 8, y, palette.dark);
    if (form === 'mascot') rect(ctx, x - 9, y + 2 + (tick % 5) * 2, 19, 1, palette.main);
  } else if (action === 'create') {
    paper(ctx, x - 6, y, '#fff4d2'); rect(ctx, x - 2, y + 6, 6, 2, palette.main); rect(ctx, x, y + 4, 2, 6, palette.main);
  } else if (action === 'modify') {
    paper(ctx, x - 8, y, '#f4eed4', true);
    rect(ctx, x + 3 - shift * 2, y + 2, 3, 12, '#b77e5f'); rect(ctx, x + 3 - shift * 2, y + 14, 3, 2, '#56634f');
  } else if (action === 'copy') {
    paper(ctx, x - 10, y - 2); paper(ctx, x, y + 2, '#e1edd4');
  } else if (action === 'move') {
    rect(ctx, x - 10, y + 2, 20, 12, '#dac18e'); rect(ctx, x - 2, y + 2, 4, 12, '#ac8c5d');
    text(ctx, '>', x + 3 + shift, y + 10, '#597452', 9);
  } else if (action === 'rename') {
    rect(ctx, x - 11, y + 3, 23, 10, '#fff4d9'); text(ctx, tick % 4 < 2 ? 'Aa' : 'Ab', x - 6, y + 11, palette.dark, 9);
  } else if (action === 'delete') {
    rect(ctx, x - 8, y + 2, 17, 12, '#e4c4aa'); rect(ctx, x - 7, y + 2, 15, 2, '#9f735e');
    text(ctx, 'x', x - 3, y + 12, '#9e6b53', 10);
  } else {
    rect(ctx, x - 9, y, 20, 14, '#58685a'); text(ctx, '>_', x - 6, y + 10, '#d9e8bd', 8);
  }
}

export function drawCharacter(ctx, x, y, config, pose = { action: 'idle', status: 'idle' }, time = 0, scale = 2) {
  const palette = PALETTES[config.provider] ?? PALETTES.generic;
  const tick = Math.floor(time / 160);
  const working = pose.action !== 'idle';
  const propAction = pose.action === 'read' && pose.status === 'running' && !pose.activityVisual ? 'request' : pose.action;
  const bob = working && tick % 2 ? -1 : 0;
  const blink = tick % 33 === 31;
  ctx.save(); ctx.translate(Math.round(x), Math.round(y)); ctx.scale(scale, scale);
  rect(ctx, -9, 14, 20, 3, '#68734b30');
  if (config.form === 'human') {
    rect(ctx, -7, 7, 5, 7, '#536050'); rect(ctx, 2, 7, 5, 7, '#536050');
    rect(ctx, -8, 13, 6, 3, '#404b40'); rect(ctx, 2, 13, 7, 3, '#404b40');
    rect(ctx, -9, -3 + bob, 18, 13, palette.dark); rect(ctx, -8, -3 + bob, 16, 11, '#eceddb');
    rect(ctx, -2, -2 + bob, 4, 11, palette.main); rect(ctx, 4, 3 + bob, 3, 3, palette.light);
    const hair = config.gender === 'feminine' ? '#796449' : config.gender === 'masculine' ? '#4c5144' : '#69694f';
    rect(ctx, -8, -18 + bob, 16, 17, hair); rect(ctx, -10, -15 + bob, 20, 10, hair);
    rect(ctx, -7, -14 + bob, 14, 12, '#eac6a0'); rect(ctx, -8, -18 + bob, 16, 5, hair);
    rect(ctx, -8, -14 + bob, 5, 4, hair);
    if (config.gender === 'feminine') { rect(ctx, -10, -9 + bob, 4, 12, hair); rect(ctx, 7, -8 + bob, 4, 10, hair); }
    if (pose.eyes === 'heart') { drawHeart(ctx, -6, -10 + bob); drawHeart(ctx, 2, -10 + bob); }
    else { rect(ctx, -4, -9 + bob, 2, blink ? 1 : 3, '#464d3f'); rect(ctx, 3, -9 + bob, 2, blink ? 1 : 3, '#464d3f'); }
    rect(ctx, 0, -4 + bob, 2, 1, '#b18b70'); rect(ctx, -6, -5 + bob, 2, 1, '#d8a284');
    const reach = pose.gesture ? 3 + tick % 2 : 0;
    rect(ctx, -11 - reach, working ? 1 + bob : 0, 4 + reach, 7, '#eceddb'); rect(ctx, 8, working ? 1 - bob : 0, 4 + reach, 7, '#eceddb');
    rect(ctx, -11 - reach, working ? 7 + bob : 7, 4, 3, '#eac6a0'); rect(ctx, 8 + reach, working ? 7 - bob : 7, 4, 3, '#eac6a0');
    if (working) actionProp(ctx, propAction, 0, 4 + bob, tick, palette, config.form);
    else if (pose.jobId && pose.gesture) paper(ctx, -6, 4 + bob, '#eee6cb');
  } else {
    rect(ctx, -9, -10 + bob, 18, 23, palette.dark); rect(ctx, -12, -5 + bob, 24, 16, palette.dark);
    rect(ctx, -8, -9 + bob, 16, 21, palette.body); rect(ctx, -11, -4 + bob, 22, 13, palette.body);
    rect(ctx, -7, -15 + bob, 4, 7, palette.main); rect(ctx, 4, -15 + bob, 4, 7, palette.main);
    if (pose.eyes === 'heart') { drawHeart(ctx, -7, -2 + bob); drawHeart(ctx, 3, -2 + bob); }
    else { rect(ctx, -6, -2 + bob, 3, blink ? 1 : 4, palette.dark); rect(ctx, 4, -2 + bob, 3, blink ? 1 : 4, palette.dark); }
    rect(ctx, 0, 4 + bob, 2, 2, palette.main); rect(ctx, -10, 4 + bob, 3, 2, '#d9aa8d'); rect(ctx, 8, 4 + bob, 3, 2, '#d9aa8d');
    rect(ctx, -8, 12, 6, 3, palette.main); rect(ctx, 3, 12, 6, 3, palette.main);
    if (pose.gesture) {
      rect(ctx, -17, 5 + bob, 4, 2, palette.main); rect(ctx, 14, 5 + bob, 4, 2, palette.main);
      rect(ctx, -20, 2 + tick % 3, 2, 2, palette.light); rect(ctx, 19, 2 + tick % 3, 2, 2, palette.light);
    }
    if (working) actionProp(ctx, propAction, 0, 7 + bob, tick, palette, config.form);
    else if (pose.jobId && pose.gesture) paper(ctx, -6, 7 + bob, '#e0eccd');
  }
  if (['unknown', 'failed', 'conflict', 'cancelled'].includes(pose.status)) {
    rect(ctx, 11, -23, 10, 11, pose.status === 'unknown' ? '#ebd7a0' : '#ddb09a');
    text(ctx, pose.status === 'unknown' ? '?' : pose.status === 'cancelled' ? '-' : '!', 13, -14, '#855c41', 10);
  }
  ctx.restore();
}

function drawDesk(ctx, x, y, palette, label) {
  rect(ctx, x - 61, y + 30, 8, 30, '#85916e'); rect(ctx, x + 53, y + 30, 8, 30, '#85916e');
  rect(ctx, x - 58, y + 30, 3, 28, '#b6bba0'); rect(ctx, x + 56, y + 30, 3, 28, '#b6bba0');
  frontBox(ctx, x - 66, y, 132, 27, 11, ['#e0d4b0', '#b4a681', '#a19373']);
  rect(ctx, x - 62, y + 2, 123, 2, '#f0e4c0');
  rect(ctx, x - 49, y + 9, 31, 15, '#c1cdb0'); paper(ctx, x - 47, y + 6);
  rect(ctx, x + 20, y - 20, 35, 27, '#526750'); rect(ctx, x + 22, y - 18, 31, 22, '#8fa782');
  rect(ctx, x + 24, y - 16, 27, 17, '#3f594b');
  rect(ctx, x + 27, y - 12, 14, 2, palette.light); rect(ctx, x + 27, y - 7, 20, 2, '#87a77e');
  rect(ctx, x + 34, y + 7, 7, 4, '#657c5c'); rect(ctx, x + 28, y + 11, 19, 3, '#8b9e78');
  frontBox(ctx, x + 21, y + 17, 32, 7, 2, ['#d2d8bd', '#9eac87', '#879772']);
  for (let n = 0; n < 6; n++) rect(ctx, x + 24 + n * 4, y + 19, 2, 2, '#839975');
  rect(ctx, x - 10, y + 2, 9, 10, '#f4efd3'); rect(ctx, x - 9, y + 2, 7, 2, '#ae9370');
  rect(ctx, x - 1, y + 4, 3, 5, '#d1d9ba');
  rect(ctx, x - 61, y + 29, 26, 6, palette.main); text(ctx, label, x - 56, y + 34, '#f4f4dd', 5);
}

function belt(ctx, points, time, width = 24) {
  // 顶面滚轴随路径切换方向；下移的底座给出正面可见厚度。
  ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';
  const stroke = (offset, size, color) => {
    ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y + offset) : ctx.moveTo(x, y + offset));
    ctx.lineWidth = size; ctx.strokeStyle = color; ctx.stroke();
  };
  stroke(6, width + 6, '#879477'); stroke(0, width + 6, '#b6c3a4');
  stroke(0, width + 2, '#e2e7cd'); stroke(0, width - 2, '#74846b');
  stroke(0, width - 6, '#a9b899');
  let covered = 0;
  const offset = Math.floor(time / 60) % 12;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = (offset - covered % 12 + 12) % 12; d < length; d += 12) {
      const x = a[0] + (b[0] - a[0]) * d / length, y = a[1] + (b[1] - a[1]) * d / length;
      if (a[1] === b[1]) rect(ctx, x, y - width / 2 + 4, 2, width - 8, '#d6dec3');
      else rect(ctx, x - width / 2 + 4, y, width - 8, 2, '#d6dec3');
    }
    covered += length;
  }
}

function tray(ctx, x, y, label, accent, count = 0) {
  frontBox(ctx, x - 15, y - 10, 30, 16, 5, ['#e5e4c9', '#b5bea0', '#90a07a']);
  rect(ctx, x - 12, y - 7, 24, 10, '#bbc9a6');
  rect(ctx, x - 13, y + 3, 26, 3, accent);
  if (count) text(ctx, String(count), x, y + 1, '#53684a', 8, 'center');
  text(ctx, label, x, y + 20, '#83916f', 7, 'center');
}

function drawRoom(ctx) {
  rect(ctx, 0, 0, 640, 380, '#e8eddd');
  rect(ctx, 42, 101, 570, 244, '#c7d1b6');
  rect(ctx, 36, 96, 570, 244, '#aab999');
  for (let row = 0; row < 13; row++) for (let col = 0; col < 18; col++) {
    const x = 38 + col * 31.5, y = 99 + row * 18;
    rect(ctx, x, y, 31, 17, (row + col) % 2 ? '#dee5ce' : '#e5ead7');
    if ((row * 7 + col * 3) % 19 === 0) rect(ctx, x + 20, y + 13, 4, 1, '#c3cfb0');
  }
  rect(ctx, 36, 34, 570, 65, '#c9d7b9'); rect(ctx, 36, 34, 570, 5, '#b1c39f');
  rect(ctx, 36, 39, 570, 3, '#e0e8ce'); rect(ctx, 36, 94, 570, 8, '#a5b990');
  rect(ctx, 38, 332, 567, 7, '#b5c5a0'); rect(ctx, 39, 333, 565, 2, '#d8e1c5');
  rect(ctx, 72, 48, 120, 39, '#819a7b'); rect(ctx, 75, 51, 114, 33, '#c4ded2');
  rect(ctx, 78, 54, 34, 15, '#e0eee0'); rect(ctx, 79, 72, 106, 9, '#b2d0bc');
  rect(ctx, 130, 50, 4, 35, '#edf0d6'); rect(ctx, 74, 66, 116, 3, '#edf0d6');
  frontBox(ctx, 67, 86, 131, 5, 4, ['#e1e5cd', '#aab996', '#8b9f78']);
  rect(ctx, 266, 52, 112, 33, '#87a077'); rect(ctx, 269, 55, 106, 27, '#e9eace');
  text(ctx, 'PAPERTRAIL', 322, 68, '#648052', 10, 'center');
  text(ctx, 'ASSEMBLY LAB / 01', 322, 78, '#8fa174', 6, 'center');
  rect(ctx, 432, 48, 79, 38, '#8b9e76'); rect(ctx, 435, 51, 73, 32, '#dcd6ad');
  paper(ctx, 443, 57, '#f2e4b6'); paper(ctx, 464, 60, '#d8e8be'); paper(ctx, 485, 54, '#e2c6a5');
  frontBox(ctx, 533, 76, 34, 6, 16, ['#d4dcc0', '#a6b68f', '#879d73']);
  for (let i = 0; i < 4; i++) rect(ctx, 538 + i * 6, 57, 4, 19, ['#a6b990', '#d8c89f'][i % 2]);
  plant(ctx, 77, 235, .9);
  rect(ctx, 90, 112, 448, 2, '#a9be91'); text(ctx, '资料入站  →  按工位分流', 308, 111, '#81976c', 7, 'center');
  text(ctx, '←  结果 / 操作单出站', 312, 350, '#9b8e63', 7, 'center');
}

function drawPacket(ctx, packet, frame) {
  const [x, y] = frame.point;
  const station = OFFICE_LAYOUT.stations[packet.agentId];
  const color = packet.phase === 'request' ? '#e6e5d7' : packet.direction === 'in' ? '#c2d7ad' : '#ead098';
  if (packet.count >= 5 || packet.phase === 'summary') {
    frontBox(ctx, x - 10, y - 12, 22, 10, 9, [color, '#abbd93', '#7e9666']);
    rect(ctx, x - 1, y - 11, 3, 9, '#eaf0d3');
    text(ctx, String(packet.count ?? '?'), x, y + 5, '#4b653d', 7, 'center');
  } else {
    paper(ctx, x - 6, y - 12, color);
    if (packet.phase === 'request') text(ctx, '?', x - 2, y - 1, '#8c9877', 7);
  }
  rect(ctx, x + 6, y - 17, 10, 9, packet.agentId === 'agent-a' ? '#608573' : '#b08961');
  text(ctx, station.label, x + 11, y - 10, '#fff9df', 7, 'center');
  if (packet.verification === 'unverified') text(ctx, '?', x - 11, y - 12, '#ae8b50', 9);
}

export function drawOffice(canvas, { agents, presentation }) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, OFFICE_LAYOUT.width, OFFICE_LAYOUT.height);
  drawRoom(ctx);
  const { time, quiet, stations, notices } = presentation;
  const animationTime = quiet ? 0 : time;
  const frames = quiet ? [] : presentation.packets.map(packet => ({ packet, frame: packet.frame }));
  for (const station of Object.values(OFFICE_LAYOUT.stations)) {
    belt(ctx, [[station.intake[0], 132], [...station.intake]], animationTime, 12);
    belt(ctx, [[...station.outlet], [station.outlet[0], 310]], animationTime, 12);
  }
  // U 形主线：上段向右，右端向下，下段向左，滚轴始终与资料方向一致。
  for (const x of [106, 318, 532]) {
    rect(ctx, x, 148, 6, 10, '#91a07b'); rect(ctx, x, 326, 6, 8, '#91a07b');
  }
  belt(ctx, OFFICE_LAYOUT.main, animationTime);
  for (const x of [102, 262, 470]) {
    text(ctx, '>', x, 135, '#6d8460', 10); text(ctx, '<', x, 313, '#8e815e', 10);
  }
  text(ctx, 'v', 584, 226, '#72865f', 10, 'center');
  for (const [y, label, color] of [[132, 'IN', '#6c9473'], [310, 'OUT', '#b79d69']]) {
    frontBox(ctx, 15, y - 17, 31, 24, 9, ['#d4ddbf', '#9eaf86', '#7d926c']);
    rect(ctx, 20, y - 11, 25, 18, '#4f6751'); rect(ctx, 21, y - 11, 24, 3, color);
    text(ctx, label, 28, y + 29, color, 8, 'center');
  }
  for (const agent of agents) {
    if (!Object.hasOwn(OFFICE_LAYOUT.stations, agent.id)) continue;
    const station = OFFICE_LAYOUT.stations[agent.id];
    const palette = PALETTES[agent.provider] ?? PALETTES.generic;
    const view = stations[agent.id];
    rect(ctx, station.x - 76, 187, 159, 93, '#cdd8bc');
    rect(ctx, station.x - 73, 190, 153, 87, '#d6e0c5');
    tray(ctx, ...station.intake, '收件', '#86a578', view.intakeCount);
    tray(ctx, ...station.outlet, '出件', '#c0a16b', view.outletCount);
    const incoming = frames.some(item => item.packet.agentId === agent.id && item.packet.direction === 'in');
    rect(ctx, station.intake[0] - 5, 144, 10, 4, incoming ? palette.main : '#b3c2a1');
    const gate = incoming && !quiet ? 3 + Math.floor(time / 160) % 3 : 2;
    rect(ctx, station.intake[0] + 5, 134, 3, gate + 7, '#738d63');
    drawDesk(ctx, station.x, station.y, palette, `LAB ${station.label}`);
    rect(ctx, station.x - 27, 245, 38, 24, '#98a981'); rect(ctx, station.x - 24, 245, 32, 5, '#b6c69c');
    rect(ctx, station.x - 20, 269, 4, 7, '#758963'); rect(ctx, station.x + 1, 269, 4, 7, '#758963');
    drawCharacter(ctx, station.x - 8, 241, agent, quiet ? { action: 'idle', status: 'idle' } : view.pose, animationTime, 1.6);
    const stats = view.execution;
    const label = stats.status === 'unknown' ? '结果待核实' : stats.running ? `${stats.running} 项在途` : stats.warning ? '有异常记录' : '执行已空闲';
    frontBox(ctx, station.x - 12, 155, 80, 18, 3, ['#f6f3da', '#d9dec2', '#b7c8a1']);
    rect(ctx, station.x - 8, 161, 4, 4, stats.warning ? '#bf9871' : palette.main);
    text(ctx, label, station.x + 30, 168, '#7c9063', 8, 'center');
    text(ctx, `${station.label} / ${agent.name}${view.activeJobId ? ` · ${view.activeJobId}` : ''}`, station.x - 8, 290, '#81906e', 8, 'center');
  }
  for (const { packet, frame } of frames) drawPacket(ctx, packet, frame);
  const count = notices.length;
  tray(ctx, 83, 272, '异常 / 待核实', '#c29b7d', count);
  if (count) { paper(ctx, 76, 256, '#e1b49a'); text(ctx, '!', 82, 268, '#a56e52', 9); }
  text(ctx, '展示托盘', 84, 256, '#97a485', 6, 'center');
}

export function drawTeamModule(canvas, { members, states, quiet = false, time = 0, collapsed = false, layoutEditing = false, level = 1, geometry = TEAM_MODULE }) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, geometry.width, geometry.height);
  // 用一张共享地毯界定团队；活动只由工位角色表达，不再模拟运输。
  if (!geometry.compact) {
    rect(ctx, 12, 38, geometry.width - 24, 116, level === 0 ? '#ede8dd' : '#e8eee8');
    rect(ctx, 16, 42, geometry.width - 32, 108, level === 0 ? '#f2eee5' : '#eff3ee');
  }
  if (collapsed) {
    plant(ctx, 38, geometry.height - 72, .65);
    return;
  }
  for (const slot of geometry.slots) {
    const member = members[slot.slot], state = states[slot.slot] ?? 'idle';
    if (!member) {
      if (layoutEditing) {
        const width = Math.min(64, slot.hit.width);
        rect(ctx, slot.x - width / 2, slot.deskY + 11, width, 37, '#d6e1c8');
        rect(ctx, slot.x - width / 2 + 3, slot.deskY + 14, width - 6, 31, '#eaf0dc');
        text(ctx, '+', slot.x, slot.deskY + 38, '#6f865b', 21, 'center');
      }
      continue;
    }
    if (geometry.compact) {
      rect(ctx, slot.hit.x + 4, slot.hit.y + 4, slot.hit.width - 8, slot.hit.height - 8, level === 0 ? '#ede8dd' : '#e8eee8');
      rect(ctx, slot.hit.x + 8, slot.hit.y + 8, slot.hit.width - 16, slot.hit.height - 16, level === 0 ? '#f2eee5' : '#eff3ee');
    }
    const palette = PALETTES[member.provider] ?? PALETTES.generic;
    ctx.save(); ctx.translate(slot.x, slot.deskY); ctx.scale(.7, .7);
    drawDesk(ctx, 0, 0, palette, `S${slot.slot + 1}`); ctx.restore();
    const action = state === 'reading' ? 'read' : ['working', 'tool'].includes(state) ? 'unknown' : 'idle';
    const status = state === 'error' ? 'failed' : state === 'unknown' ? 'unknown' : state === 'waiting' ? 'unknown' : 'running';
    drawCharacter(ctx, slot.x - 14, slot.characterY, member,
      { action: quiet ? 'idle' : action, status, activityVisual: true }, quiet ? 0 : time, 1.1);
    const stateLight = state === 'error' ? '#a34c3d' : state === 'waiting' ? '#b58c42' : state === 'unknown' ? '#66767d'
      : ['reading', 'working', 'tool'].includes(state) ? '#527fa0' : state === 'done' ? '#6d9256' : '#94a587';
    rect(ctx, slot.x + 34, slot.deskY - 11, 5, 5, stateLight);
  }
}

export function drawAvatar(canvas, config) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 48, 48);
  drawCharacter(ctx, 24, 28, config, { action: 'idle', status: 'idle' }, 0, 1.3);
}
