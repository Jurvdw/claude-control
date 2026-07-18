import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Notification } from '../lib/types';
import { notifications as notifApi } from '../lib/api';
import { onSocketEvent } from '../lib/socket';
import { ensureNotifyPermission, desktopNotify } from '../lib/desktopNotify';
import { useAuth } from './AuthContext';

interface Toast {
  id: string;
  title: string;
  body?: string;
  kind?: 'info' | 'success' | 'error';
}

interface NotificationContextValue {
  notifications: Notification[];
  unreadCount: number;
  toasts: Toast[];
  addToast: (title: string, body?: string, kind?: Toast['kind']) => void;
  dismissToast: (id: string) => void;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

let toastSeq = 0;

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (!user) return;
    notifApi.list().then(({ notifications }) => setNotifs(notifications)).catch(() => {});
  }, [user]);

  useEffect(() => {
    if (!user) return;
    ensureNotifyPermission();
    const off = onSocketEvent('notification', (data: unknown) => {
      const { notification } = data as { notification: Notification };
      setNotifs(prev => [notification, ...prev]);
      addToast(notification.title, notification.body, notification.kind === 'error' ? 'error' : 'info');
      desktopNotify(notification.title, notification.body);
    });
    return off;
  }, [user]);

  const addToast = useCallback((title: string, body?: string, kind: Toast['kind'] = 'info') => {
    const id = String(++toastSeq);
    const toast: Toast = { id, title, body, kind };
    setToasts(prev => [...prev, toast]);
    timers.current[id] = setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      delete timers.current[id];
    }, 4000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const markRead = async (id: string) => {
    await notifApi.read(id);
    setNotifs(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  };

  const markAllRead = async () => {
    await notifApi.readAll();
    setNotifs(prev => prev.map(n => ({ ...n, read: true })));
  };

  const unreadCount = notifs.filter(n => !n.read).length;

  return (
    <NotificationContext.Provider value={{ notifications: notifs, unreadCount, toasts, addToast, dismissToast, markRead, markAllRead }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error('useNotifications must be used within NotificationProvider');
  return ctx;
}
