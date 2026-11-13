export const APP_ORIGIN = 'papertrail://app';
export function trustedSender(event, window, expectedPath) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents) return false;
  try {
    const frame = event.senderFrame;
    if (!frame || frame !== window.webContents.mainFrame) return false;
    const url = new URL(frame.url);
    return url.protocol === 'papertrail:' && url.hostname === 'app' && url.pathname === expectedPath && !url.search && !url.hash;
  } catch { return false; }
}
export function payloadWithinLimit(value) {
  try { return JSON.stringify(value ?? null).length <= 16384; } catch { return false; }
}
