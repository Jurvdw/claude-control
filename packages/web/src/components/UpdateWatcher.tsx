import { useEffect, useRef } from 'react';
import { useNotifications } from '../state/NotificationContext';

// Update lifecycle, surfaced through the normal toast system. Renders nothing.
// Only does anything inside the Electron shell (window.ccDesktop is injected by
// preload.cjs); in a browser tab it's inert.

interface UpdateEvent {
  state: 'available' | 'downloading' | 'ready' | 'current' | 'error';
  version?: string;
  percent?: number;
  message?: string;
}

declare global {
  interface Window {
    ccDesktop?: {
      version(): Promise<string>;
      onUpdate(cb: (e: UpdateEvent) => void): () => void;
      installNow(): Promise<void>;
      pickFolder(): Promise<string | null>;
    };
  }
}

export default function UpdateWatcher() {
  const { addToast } = useNotifications();
  // Downloads emit a progress event per chunk — toast only on the first one.
  const announced = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const desktop = window.ccDesktop;
    if (!desktop) return;

    return desktop.onUpdate((e) => {
      if (e.state === 'available' && !announced.current.available) {
        announced.current.available = true;
        addToast('Update available', `Downloading ${e.version ?? 'a new version'} in the background…`, 'info');
      }
      if (e.state === 'ready' && !announced.current.ready) {
        announced.current.ready = true;
        addToast(
          `Update ${e.version ?? ''} ready`.trim(),
          'It installs automatically the next time you close Claude Control — your running agents are left alone.',
          'success',
        );
      }
      // 'current', 'downloading' and 'error' stay silent: nothing for the user
      // to do, and a failed update check is not their problem.
    });
  }, [addToast]);

  return null;
}
