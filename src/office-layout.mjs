const frozenPath = points => Object.freeze(points.map(point => Object.freeze(point)));
export const OFFICE_LAYOUT = Object.freeze({
  width: 640, height: 380,
  main: frozenPath([[38, 132], [584, 132], [584, 310], [38, 310]]),
  stations: Object.freeze({
    'agent-a': Object.freeze({ x: 210, y: 198, intake: Object.freeze([162, 170]), outlet: Object.freeze([286, 268]), label: 'A' }),
    'agent-b': Object.freeze({ x: 420, y: 198, intake: Object.freeze([372, 170]), outlet: Object.freeze([496, 268]), label: 'B' }),
  }),
});
export const TRANSPORT = Object.freeze({ pixelsPerMs: 0.25, spacing: 36 });

// 组织视图的可插拔工位岛；绘图、按钮命中与拖放共用这一份几何。
export const TEAM_MODULE = Object.freeze({
  width: 432, height: 184, header: 49, footer: 26, frame: 1, gap: 24, bandHeight: 300,
  slots: Object.freeze([76, 216, 356].map((x, slot) => Object.freeze({
    slot, x, deskY: 64, characterY: 117,
    hit: Object.freeze({ x: x - 61, y: 44, width: 122, height: 103 }),
  }))),
});

// 紧凑工作台不缩放角色；只减少空列与桌椅四周留白，旧版默认几何不变。
export const COMPACT_TEAM = Object.freeze({
  minWidth: 206, height: 122, header: 46, footer: 32, frame: 1, gap: 12, bandHeight: 244,
  column: 130, emptyColumn: 32, padding: 6, offset: 36, seatTop: 8,
});

// 真实工位只投影日志快照；不创建或修改模拟组织，身份与来源会话分开标记。
export const QODER_STATION = Object.freeze({ width: COMPACT_TEAM.minWidth, height: COMPACT_TEAM.height, compact: true,
  slots: Object.freeze([Object.freeze({ slot: 0, x: COMPACT_TEAM.minWidth / 2, deskY: 28, characterY: 81,
    hit: Object.freeze({ x: COMPACT_TEAM.minWidth / 2 - 61, y: COMPACT_TEAM.seatTop, width: 122, height: 103 }) })]) });
export function qoderWorkstations(snapshot, now = Date.now()) {
  const live = snapshot.enabled === true && snapshot.status === 'watching';
  const staleMs = snapshot.sync?.staleMs ?? 60000;
  const station = (source, sessionId, kind) => {
    const stale = source.stale === true || (Number.isFinite(source.lastSeen) && now - source.lastSeen > staleMs);
    const state = !live || stale ? 'unknown' : ['idle', 'reading', 'working', 'tool', 'waiting', 'error', 'done', 'unknown'].includes(source.state) ? source.state : 'unknown';
    return { id: JSON.stringify(['qoder', sessionId, kind, source.id]), sourceId: source.id, sessionId, kind,
      name: source.name ?? (kind === 'session' ? `Qoder ${source.id.slice(0, 8)}` : `子智能体 ${source.id.slice(0, 8)}`),
      state, stale, lastSeen: source.lastSeen ?? null, lifecycle: source.lifecycle ?? null,
      detail: !live ? '监听未就绪，保留最后身份；当前状态未知' : stale ? '超过 60 秒没有新证据，当前状态未知' : source.detail,
      toolCalls: source.toolCalls ?? 0, activeTools: source.activeTools ?? 0, failures: source.failures ?? 0,
      geometry: QODER_STATION, readOnly: true };
  };
  return (snapshot.sessions ?? []).map(session => ({ id: session.id, name: session.name ?? `Qoder ${session.id.slice(0, 8)}`,
    station: station(session, session.id, 'session'),
    // 停止记录仍留作证据，但不占工位；未知状态不能代替停止信号。
    children: (session.children ?? []).filter(child => child.lifecycle === 'started')
      .map(child => station(child, session.id, 'subagent')) }));
}

export function organizationLayout(model, projectId) {
  model.project(projectId);
  const height = COMPACT_TEAM.height + COMPACT_TEAM.header + COMPACT_TEAM.footer + 2 * COMPACT_TEAM.frame;
  // 先为全部工位岛和后代留列；折叠、分页与活动更新不改变几何。
  const reserved = [...model.zones.values()].filter(zone => zone.projectId === projectId
    && (!zone.parentId || model.depth(zone.parentId) + 1 === zone.depth)
    && (zone.depth === 0 || model.zoneMembers(zone.id).length))
    .sort((a, b) => (a.depth ?? 99) - (b.depth ?? 99) || a.order - b.order);
  const childZones = new Map(reserved.filter(zone => zone.parentId).map(zone => [zone.parentId, zone]));
  const geometries = new Map();
  for (const zone of [...reserved].reverse()) {
    const columns = TEAM_MODULE.slots.map((slot, index) => zone.modules.some(module => module.slots[index])
      ? COMPACT_TEAM.column : COMPACT_TEAM.emptyColumn);
    for (const module of zone.modules) for (const [slot, id] of module.slots.entries()) {
      const child = childZones.get(id), geometry = child && geometries.get(child.id);
      if (geometry) columns[slot] = Math.max(columns[slot], geometry.width + 2 * COMPACT_TEAM.frame + COMPACT_TEAM.gap);
    }
    // 空车间仍容纳标题、分页和添加入口；有人时按实际占用列紧凑排布。
    columns[0] += Math.max(0, COMPACT_TEAM.minWidth - columns.reduce((sum, width) => sum + width, 2 * COMPACT_TEAM.padding));
    let left = COMPACT_TEAM.padding;
    const slots = TEAM_MODULE.slots.map((slot, index) => {
      const x = left + columns[index] / 2, hitWidth = Math.min(slot.hit.width, columns[index] - 8);
      left += columns[index];
      const shiftY = slot.hit.y - COMPACT_TEAM.seatTop;
      return { ...slot, x, deskY: slot.deskY - shiftY, characterY: slot.characterY - shiftY,
        hit: { ...slot.hit, x: x - hitWidth / 2, y: slot.hit.y - shiftY, width: hitWidth } };
    });
    geometries.set(zone.id, { width: left + COMPACT_TEAM.padding, height: COMPACT_TEAM.height, compact: true, slots });
  }
  const positions = new Map();
  for (const zone of reserved) {
    const geometry = geometries.get(zone.id), width = geometry.width + 2 * COMPACT_TEAM.frame;
    const parentSeat = zone.parentId ? model.assignments.get(zone.parentId) : null;
    const parentShape = parentSeat ? positions.get(parentSeat.zoneId) : null;
    const parentX = parentShape ? parentShape.x + COMPACT_TEAM.frame + parentShape.geometry.slots[parentSeat.slot].x : null;
    const root = [...positions.values()].find(shape => shape.depth === 0);
    const x = zone.depth == null ? (root ? root.x + root.width : 12 + COMPACT_TEAM.minWidth + 2 * COMPACT_TEAM.frame) + COMPACT_TEAM.gap
      : parentX == null ? 12 : parentX - width / 2;
    const shape = { id: zone.id, depth: zone.depth, x, y: (zone.depth ?? 0) * COMPACT_TEAM.bandHeight + COMPACT_TEAM.offset,
      width, height, geometry, moduleId: zone.modules[zone.page].id, slots: [...zone.modules[zone.page].slots], collapsed: zone.collapsed,
      ownerSeat: parentSeat ? { agentId: zone.parentId, moduleId: parentSeat.moduleId, slot: parentSeat.slot,
        page: model.zones.get(parentSeat.zoneId).modules.findIndex(module => module.id === parentSeat.moduleId) } : null };
    positions.set(zone.id, shape);
  }
  const zones = model.visibleZones(projectId).filter(zone => {
    if (!positions.has(zone.id)) return false;
    // 不把其他岛的下属摆在当前页同一插槽下，避免误认负责人。
    let parent = zone.parentId;
    while (parent) {
      const seat = model.assignments.get(parent), ownerZone = model.zones.get(seat.zoneId);
      if (ownerZone.modules[ownerZone.page].id !== seat.moduleId) return false;
      parent = model.agent(parent).parentId;
    }
    return true;
  });
  const levels = [...new Set(zones.map(zone => zone.depth))];
  const bands = levels.map(depth => {
    const shapes = zones.filter(zone => zone.depth === depth).map(zone => positions.get(zone.id));
    const x = depth == null ? Math.min(...shapes.map(shape => shape.x)) : 12;
    return { depth, x, y: (depth ?? 0) * COMPACT_TEAM.bandHeight,
      width: Math.max(...shapes.map(shape => shape.x + shape.width)) - x,
      label: depth == null ? '独立协作 · 无委派层级' : depth === 0 ? 'L0 · 协调区' : depth === 1 ? 'L1 · 执行区' : `L${depth} · 子团队`,
      zones: shapes };
  });
  return { width: Math.max(COMPACT_TEAM.minWidth + 26, ...[...positions.values()].map(shape => shape.x + shape.width + 12)),
    height: Math.max(COMPACT_TEAM.bandHeight, ...reserved.map(zone => ((zone.depth ?? 0) + 1) * COMPACT_TEAM.bandHeight)), bands };
}

export function packetRoute({ agentId, direction }) {
  if (!Object.hasOwn(OFFICE_LAYOUT.stations, agentId)) return null;
  const station = OFFICE_LAYOUT.stations[agentId];
  if (direction === 'in') return [[38, 132], [station.intake[0], 132], [...station.intake]];
  if (direction === 'out') return [[...station.outlet], [station.outlet[0], 310], [38, 310]];
  return null;
}
export function pathLength(points) {
  return points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point[0] - points[i][0], point[1] - points[i][1]), 0);
}
export function pointOnPath(points, ratio) {
  if (!points?.length) return null;
  let distance = pathLength(points) * Math.max(0, Math.min(1, ratio));
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!length) continue;
    if (distance <= length) return [a[0] + (b[0] - a[0]) * distance / length, a[1] + (b[1] - a[1]) * distance / length];
    distance -= length;
  }
  return [...points.at(-1)];
}
export function packetFrame(packet, now) {
  const path = packetRoute(packet);
  if (!path || !Number.isFinite(now) || !Number.isFinite(packet.bornAt)
    || !Number.isFinite(packet.duration) || packet.duration <= 0) return null;
  const progress = (now - packet.bornAt) / packet.duration;
  if (progress < 0 || progress >= 1) return null;
  return { point: pointOnPath(path, progress), progress, handling: false };
}

// 相同方向的路由由轴对齐线段构成。连续时间求最小距离，覆盖分流、汇入和转角。
export function transportConflict(a, b, spacing = TRANSPORT.spacing) {
  const begin = Math.max(a.bornAt, b.bornAt);
  const end = Math.min(a.bornAt + a.duration, b.bornAt + b.duration);
  if (begin >= end) return false;
  const cuts = [begin, end];
  for (const packet of [a, b]) {
    const path = packetRoute(packet);
    let length = 0;
    for (let i = 1; i < path.length; i++) {
      length += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      const time = packet.bornAt + length / TRANSPORT.pixelsPerMs;
      if (time > begin && time < end) cuts.push(time);
    }
  }
  cuts.sort((x, y) => x - y);
  const position = (p, t) => pointOnPath(packetRoute(p), (t - p.bornAt) / p.duration);
  for (let i = 1; i < cuts.length; i++) {
    const t0 = cuts[i - 1], t1 = cuts[i];
    if (t0 === t1) continue;
    const a0 = position(a, t0), b0 = position(b, t0), a1 = position(a, t1), b1 = position(b, t1);
    const r = [a0[0] - b0[0], a0[1] - b0[1]];
    const v = [a1[0] - b1[0] - r[0], a1[1] - b1[1] - r[1]];
    const norm = v[0] ** 2 + v[1] ** 2;
    const f = norm ? Math.max(0, Math.min(1, -(r[0] * v[0] + r[1] * v[1]) / norm)) : 0;
    if (Math.hypot(r[0] + v[0] * f, r[1] + v[1] * f) < spacing - 1e-7) return true;
  }
  return false;
}
