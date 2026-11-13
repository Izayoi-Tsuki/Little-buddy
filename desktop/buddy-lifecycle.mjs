// Electron 原生对象销毁后，除 isDestroyed 外的查询也会抛错；先检查存活，再访问窗口。
export const nativeAlive = object => !!object && !object.isDestroyed();
export function windowVisible(window, quitting = false) {
  return !quitting && nativeAlive(window) && window.isVisible();
}
