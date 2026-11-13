const { contextBridge, ipcRenderer, webUtils } = require('electron');

const unwrap = response => {
  if (!response?.ok) throw new Error(response?.error || '桌面请求失败');
  return response.value;
};
const listen = (channel, callback) => {
  if (typeof callback !== 'function') throw new Error('订阅需要回调');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
// 只把拖入文件的路径交给主进程；页面拿不到文件系统、任意频道或命令执行能力。
contextBridge.exposeInMainWorld('fileBuddy', Object.freeze({
  getState: () => ipcRenderer.invoke('buddy:get-state').then(unwrap),
  onState: callback => listen('buddy:state', callback),
  onVisibility: callback => listen('buddy:visibility', callback),
  onEdit: callback => listen('buddy:edit', callback),
  onLink: callback => listen('buddy:link', callback),
  onLinkTarget: callback => listen('buddy:link-target', callback),
  onEmote: callback => listen('buddy:emote', callback),
  onBubble: callback => listen('buddy:bubble', callback),
  drop: file => {
    let path = '';
    try { path = webUtils.getPathForFile(file) || ''; } catch { path = ''; }
    return ipcRenderer.invoke('buddy:drop', path).then(unwrap);
  },
  command: (type, value) => ipcRenderer.invoke('buddy:command', { type, value }).then(unwrap),
  dragStart: () => ipcRenderer.send('buddy:drag', 'start'),
  dragEnd: () => ipcRenderer.send('buddy:drag', 'end'),
}));
