import { SQUAD_COLORS } from './file-buddy.mjs';

// 小队军衔：带队者三道杠，成员一道杠，没有带队者的同伴小队每只两道杠。
export const rankBars = squad => !squad ? 0 : squad.lead ? 3 : squad.led ? 1 : 2;
export const RANK_SIZE = { width: 13, height: 12 };
export const RANK_PAPER = '#fff8df';
// 13×12 的臂章：小队深色外框、浅色衬底，横杠用小队主色，杠组垂直居中。
export function drawRank(ctx, x, y, bars, colorId) {
  if (!bars) return;
  const c = SQUAD_COLORS[colorId] ?? SQUAD_COLORS.steel;
  const px = (dx, dy, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(Math.round(x + dx), Math.round(y + dy), w, h); };
  px(0, 0, 13, 12, c.dark); px(1, 1, 11, 10, RANK_PAPER);
  const top = 1 + Math.floor((10 - (bars * 3 - 1)) / 2);
  for (let i = 0; i < bars; i++) px(2, top + i * 3, 9, 2, c.main);
}
