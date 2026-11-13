// 桌宠头顶的对话框：只显示主进程发来的文字，没有任何命令权限。
const bridge = window.fileBuddy, $ = id => document.getElementById(id);
function show(data) {
  const bubble = $('bubble');
  if (!data?.text) { bubble.hidden = true; return; }
  $('bubble-text').textContent = data.text; bubble.dataset.kind = data.kind ?? 'say'; bubble.hidden = false;
  // 重新触发弹出或抖动动画。
  bubble.classList.remove('is-popping', 'is-shaking'); void bubble.offsetWidth;
  bubble.classList.add(data.shake ? 'is-shaking' : 'is-popping');
}
if (bridge) bridge.onBubble(show);
