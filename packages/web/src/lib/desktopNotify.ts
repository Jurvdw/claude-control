// Native OS notifications via the Web Notification API. In the Electron
// renderer these render as real desktop notifications — no IPC needed. We only
// fire them when the window isn't focused, so they complement (not duplicate)
// the in-app toasts.

let asked = false;

export function ensureNotifyPermission(): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default' && !asked) {
    asked = true;
    Notification.requestPermission().catch(() => {});
  }
}

export function desktopNotify(title: string, body?: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (typeof document !== 'undefined' && document.hasFocus()) return; // window is focused → toast is enough
  try {
    const n = new Notification(title, { body, silent: false });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {
    /* platform refused — ignore */
  }
}
