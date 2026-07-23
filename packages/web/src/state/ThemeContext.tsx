import { createContext, useContext, useLayoutEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'cc.theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

function resolve(theme: Theme, systemPrefersLight: boolean): 'light' | 'dark' {
  return theme === 'system' ? (systemPrefersLight ? 'light' : 'dark') : theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readStored);

  useLayoutEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => document.documentElement.setAttribute('data-theme', resolve(theme, mql.matches));
    apply();
    if (theme !== 'system') return;
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [theme]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  };

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
