# Light Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a System/Light/Dark theme selector to Settings, backed by a light palette that swaps in without touching any of the 28 component files that already reference the `ink`/`cream`/`clay` Tailwind color classes.

**Architecture:** Convert the Tailwind palette from literal hex to CSS custom properties (RGB-triplet values, Tailwind's documented `rgb(var(--x) / <alpha-value>)` pattern so existing opacity-modifier classes like `bg-clay/20` keep working). Two variable sets in `index.css` — `:root` (dark, unchanged values) and `:root[data-theme="light"]` (new light palette) — toggled by setting `data-theme` on `<html>`. A new `ThemeContext` resolves System/Light/Dark to that attribute and persists the choice to `localStorage`. A new Settings section wires a selector to it.

**Tech Stack:** React context (matches `NotificationContext`/`ServerContext` pattern), Tailwind CSS custom-property theming, `localStorage`, `matchMedia`, Playwright e2e (no unit test runner exists in `packages/web` — confirmed via `packages/web/package.json`, no `test` script/vitest/jest present — so behavioral verification is e2e-only, not unit-level).

## Global Constraints

- No new runtime dependency — CSS variables + React context only.
- No `dark:` Tailwind variant rewrite, no changes to any of the 28 files that reference `ink-*`/`cream-*`/`clay-*` classes — per spec §3, this is the whole point of the CSS-variable approach.
- `localStorage` key is exactly `cc.theme`, values `'system' | 'light' | 'dark'`, default `'system'`. Follows the existing bare-`localStorage`-with-try/catch convention already used for `cc.wf.sel.<serverId>` in `WorkflowsPanel.tsx` — no typed wrapper exists in this codebase, don't introduce one.
- Clay accent (`#d97757` family) stays byte-identical across both themes — spec §3 says the accent is unchanged.
- Settings gets one new section titled "Appearance", using the existing private `Section`/`TabBtn` components already defined in `SettingsPanel.tsx` — don't invent a new control style.
- Aside, not in scope: `text-ink-400` and `text-cream-300` appear in a few existing component files but were never defined in `tailwind.config.js`'s `ink`/`cream` scales (checked: the scales are `ink: {900,850,800,750,700,600,500}`, `cream: {50,100,200,400}` — no 400/300 respectively). Those classes are already no-ops today, in both the current dark-only build and after this plan. Not this plan's job to fix — pre-existing, unrelated.

---

### Task 1: CSS custom properties for the palette

**Files:**
- Modify: `packages/web/tailwind.config.js` (full file — the `colors` block changes; `fontFamily`/`keyframes`/`animation` stay identical)
- Modify: `packages/web/src/index.css` (full file)

**Interfaces:**
- Consumes: nothing (no prior task).
- Produces: CSS variables `--ink-900`, `--ink-850`, `--ink-800`, `--ink-750`, `--ink-700`, `--ink-600`, `--ink-500`, `--cream-50`, `--cream-100`, `--cream-200`, `--cream-400`, `--clay`, `--clay-400`, `--clay-500`, `--clay-600`, `--clay-700` (each an RGB triplet, space-separated, no `rgb()` wrapper, e.g. `217 119 87`), defined on `:root` (dark values, byte-identical to today) and overridden on `:root[data-theme="light"]` (new light values). Every later task that sets `data-theme="light"|"dark"` on `<html>` relies on these selectors existing exactly as `:root` / `:root[data-theme="light"]`.

- [ ] **Step 1: Replace `packages/web/src/index.css` in full**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/*
 * Dark values are byte-identical to the pre-theme literals they replace
 * (#141311, #1a1915, ... #d97757, ...) — just expressed as space-separated
 * RGB triplets so Tailwind's rgb(var(--x) / <alpha-value>) pattern can add
 * opacity for classes like bg-clay/20 or border-ink-700/60 (both are used
 * in the app today — a plain hex custom property would break those).
 */
:root {
  --ink-900: 20 19 17;
  --ink-850: 26 25 21;
  --ink-800: 33 31 26;
  --ink-750: 40 37 31;
  --ink-700: 51 47 40;
  --ink-600: 65 60 51;
  --ink-500: 90 84 74;
  --cream-50: 250 249 245;
  --cream-100: 243 241 234;
  --cream-200: 230 226 214;
  --cream-400: 184 178 164;
  --clay: 217 119 87;
  --clay-400: 224 138 109;
  --clay-500: 217 119 87;
  --clay-600: 194 95 63;
  --clay-700: 160 74 48;
  color-scheme: dark;
}

/* Light palette: cream tones take the background/surface roles ink held in
 * dark mode, ink tones take the text/foreground roles cream held. Clay is
 * unchanged. First-pass values — expected to be eyeballed/tuned in-browser,
 * not final by construction, but every value here is real (no TBD). */
:root[data-theme='light'] {
  --ink-900: 255 255 255;
  --ink-850: 250 247 242;
  --ink-800: 232 227 216;
  --ink-750: 239 233 221;
  --ink-700: 221 214 200;
  --ink-600: 163 156 140;
  --ink-500: 138 131 117;
  --cream-50: 31 28 23;
  --cream-100: 44 40 32;
  --cream-200: 61 55 44;
  --cream-400: 92 86 72;
  --clay: 217 119 87;
  --clay-400: 224 138 109;
  --clay-500: 217 119 87;
  --clay-600: 194 95 63;
  --clay-700: 160 74 48;
  color-scheme: light;
}

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  background-color: rgb(var(--ink-850));
  color: rgb(var(--cream-100));
  font-family: Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Thin, unobtrusive scrollbars in the Claude palette. */
* {
  scrollbar-width: thin;
  scrollbar-color: rgb(var(--ink-600)) transparent;
}
*::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
*::-webkit-scrollbar-thumb {
  background: rgb(var(--ink-600));
  border-radius: 4px;
}
```

- [ ] **Step 2: Replace `packages/web/tailwind.config.js` in full**

```js
/** @type {import('tailwindcss').Config} */
function withOpacity(varName) {
  return ({ opacityValue }) =>
    opacityValue === undefined ? `rgb(var(${varName}))` : `rgb(var(${varName}) / ${opacityValue})`;
}

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Claude Code palette — deep charcoal/grey + warm orange accent.
        // Values come from CSS custom properties (see index.css) so they can
        // swap per data-theme without touching any component file.
        ink: {
          900: withOpacity('--ink-900'),
          850: withOpacity('--ink-850'),
          800: withOpacity('--ink-800'),
          750: withOpacity('--ink-750'),
          700: withOpacity('--ink-700'),
          600: withOpacity('--ink-600'),
          500: withOpacity('--ink-500'),
        },
        cream: {
          50: withOpacity('--cream-50'),
          100: withOpacity('--cream-100'),
          200: withOpacity('--cream-200'),
          400: withOpacity('--cream-400'),
        },
        clay: {
          DEFAULT: withOpacity('--clay'),
          400: withOpacity('--clay-400'),
          500: withOpacity('--clay-500'),
          600: withOpacity('--clay-600'),
          700: withOpacity('--clay-700'),
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        'fade-in': { '0%': { opacity: '0', transform: 'translateY(4px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        'pulse-dot': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.35' } },
        'slide-in': { '0%': { opacity: '0', transform: 'translateX(8px)' }, '100%': { opacity: '1', transform: 'translateX(0)' } },
      },
      animation: {
        'fade-in': 'fade-in 0.2s ease-out',
        'pulse-dot': 'pulse-dot 1.4s ease-in-out infinite',
        'slide-in': 'slide-in 0.25s ease-out',
      },
    },
  },
  plugins: [],
};
```

- [ ] **Step 3: Build to verify no compile errors and no visual regression**

Run: `npm run build -w @cc/web`
Expected: build succeeds. No `data-theme` attribute is set on `<html>` anywhere yet (Task 2 adds that), so `:root`'s dark values are the only ones in effect — output is pixel-identical to before this task.

- [ ] **Step 4: Commit**

```bash
git add packages/web/tailwind.config.js packages/web/src/index.css
git commit -m "theme: convert palette to CSS custom properties"
```

---

### Task 2: ThemeContext

**Files:**
- Create: `packages/web/src/state/ThemeContext.tsx`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: the `:root[data-theme="light"]` selector from Task 1 (sets the `data-theme` attribute Task 1's CSS keys off of).
- Produces: `export type Theme = 'system' | 'light' | 'dark'`; `export function ThemeProvider({ children }: { children: React.ReactNode })`; `export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void }` — Task 3's Settings section imports `useTheme` from this exact path.

- [ ] **Step 1: Create `packages/web/src/state/ThemeContext.tsx`**

```tsx
import { createContext, useContext, useEffect, useState } from 'react';

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

  useEffect(() => {
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
```

- [ ] **Step 2: Wire `ThemeProvider` as the outermost provider in `packages/web/src/App.tsx`**

Full file after the change:

```tsx
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './state/AuthContext';
import { NotificationProvider } from './state/NotificationContext';
import { ServerProvider } from './state/ServerContext';
import { TourProvider } from './state/TourContext';
import { ThemeProvider } from './state/ThemeContext';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import OnboardingPage from './pages/OnboardingPage';
import AppPage from './pages/AppPage';
import Toasts from './components/Toasts';

function Loading() {
  return (
    <div className="h-full flex items-center justify-center text-cream-400">
      <div className="animate-pulse-dot text-clay text-2xl font-semibold">Claude Control</div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

function Shell() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/onboarding" element={<RequireAuth><OnboardingPage /></RequireAuth>} />
      <Route
        path="/:serverId?/:channelId?"
        element={
          <RequireAuth>
            <ServerProvider>
              <TourProvider>
                <AppPage />
              </TourProvider>
            </ServerProvider>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <NotificationProvider>
          <div className="h-full">
            <Shell />
            <Toasts />
          </div>
        </NotificationProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
```

`ThemeProvider` wraps `AuthProvider` (not nested inside it) so the theme applies on the login/register screens too, before any authentication exists.

- [ ] **Step 3: Manual smoke-check (no unit test runner exists in `packages/web` — see Global Constraints; full behavioral coverage lands in Task 4's e2e test)**

Run: `npm run dev -w @cc/web` (or the root `npm run dev`), open the app in a browser, open devtools console, and run:

```js
localStorage.setItem('cc.theme', 'light'); location.reload();
```

Expected after reload: `document.documentElement.getAttribute('data-theme')` returns `"light"` in the console, and the page background/text visibly swap to the light palette from Task 1.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/state/ThemeContext.tsx packages/web/src/App.tsx
git commit -m "theme: add ThemeContext (system/light/dark resolution + persistence)"
```

---

### Task 3: Settings "Appearance" section

**Files:**
- Modify: `packages/web/src/components/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `useTheme` from `../state/ThemeContext` (Task 2); the existing private `Section` and `TabBtn` components already defined in this same file (`Section({ title, desc, busy, children })` at line ~865, `TabBtn({ active, onClick, children })` at line ~917 — both already used elsewhere in this file, not modified by this task).
- Produces: nothing new consumed by later tasks — this is a leaf UI change.

- [ ] **Step 1: Add the import**

In `packages/web/src/components/SettingsPanel.tsx`, add to the top import block (after the existing `Button, Input` import from `./ui`):

```tsx
import { useTheme } from '../state/ThemeContext';
```

- [ ] **Step 2: Add the `AppearanceSection` component**

Add this function near `AboutSection` (defined at line ~396) — place it directly above `AboutSection`:

```tsx
function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <Section title="Appearance" desc="Choose a color theme, or follow your system setting.">
      <div className="flex gap-2">
        <TabBtn active={theme === 'system'} onClick={() => setTheme('system')}>System</TabBtn>
        <TabBtn active={theme === 'light'} onClick={() => setTheme('light')}>Light</TabBtn>
        <TabBtn active={theme === 'dark'} onClick={() => setTheme('dark')}>Dark</TabBtn>
      </div>
    </Section>
  );
}
```

- [ ] **Step 3: Render it in the main `SettingsPanel` return, just before `AboutSection`**

Find (around line 263-267):

```tsx
        {/* ── Privacy vault ─────────────────────────────────────────────── */}
        <VaultSection />

        {/* ── About / version ───────────────────────────────────────────── */}
        <AboutSection />
```

Replace with:

```tsx
        {/* ── Privacy vault ─────────────────────────────────────────────── */}
        <VaultSection />

        {/* ── Appearance ────────────────────────────────────────────────── */}
        <AppearanceSection />

        {/* ── About / version ───────────────────────────────────────────── */}
        <AboutSection />
```

- [ ] **Step 4: Build to verify no type/compile errors**

Run: `npm run build -w @cc/web`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/SettingsPanel.tsx
git commit -m "theme: add Appearance section to Settings"
```

---

### Task 4: e2e regression test

**Files:**
- Modify: `packages/desktop/e2e/app.spec.ts`

**Interfaces:**
- Consumes: the full stack from Tasks 1-3 (CSS variables, `ThemeProvider`, the Settings "Appearance" section) via the real running app — no direct code interface, this is an end-to-end assertion.

- [ ] **Step 1: Add the test**

Append inside the existing `test.describe('Claude Control desktop', ...)` block in `packages/desktop/e2e/app.spec.ts`, after the last existing test (`walks through the first-run tour`):

```ts
  test('sets a light theme via Settings and persists it across reload', async ({ page }) => {
    await signUp(page);
    await createWorkspace(page);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Light' }).click();

    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('light');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(250, 247, 242)'); // --ink-850 in light mode, see index.css

    await page.reload();
    await page.getByRole('heading', { name: /# general/ }).waitFor({ timeout: 60_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')))
      .toBe('light');
    const stored = await page.evaluate(() => localStorage.getItem('cc.theme'));
    expect(stored).toBe('light');
  });
```

- [ ] **Step 2: Run the full e2e suite**

Run: `npm run e2e -w claude-control` (from repo root; requires the packaged app to be current — if this test fails with content that looks stale relative to Tasks 1-3's changes, run `npm run dist` at the repo root first to rebuild the packaged exe, then retry)
Expected: all tests pass, including the new one — output line `NN passed (...)` with `NN` equal to the prior test count plus one, and no failures.

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/e2e/app.spec.ts
git commit -m "test: add e2e coverage for the light theme toggle"
```

---

## Self-Review

**Spec coverage:** §3's four bullet points are each covered — CSS custom properties + two variable sets (Task 1), `useTheme` hook with system/light/dark resolution + localStorage persistence + live `matchMedia` subscription (Task 2), Settings Appearance section with System/Light/Dark selector defaulting to System (Task 2's `readStored` default + Task 3's UI), and an e2e test (Task 4). The spec's `color-scheme` note is covered (Task 1 sets it per-theme). The spec's "zero component files touched" claim is upheld — only `index.css`, `tailwind.config.js`, one new context file, `App.tsx`, `SettingsPanel.tsx` (to add the new section), and the e2e spec are touched; none of the 28 files using `ink-*`/`cream-*`/`clay-*` classes are modified.

**Placeholder scan:** no TBD/TODO; every hex/RGB value is concrete; the "first-pass, expected to be eyeballed" note in Task 1's CSS comment is a documented design decision (also stated in the spec itself), not a missing value.

**Type/signature consistency:** `Theme` type (`'system' | 'light' | 'dark'`) is defined once in `ThemeContext.tsx` (Task 2) and used identically in Task 3's `theme === 'system' | 'light' | 'dark'` comparisons. `useTheme()`'s return shape (`{ theme, setTheme }`) matches its only consumer (Task 3). `STORAGE_KEY = 'cc.theme'` matches the Global Constraints line and Task 4's assertion (`localStorage.getItem('cc.theme')`). CSS variable names (`--ink-900`, etc.) are identical between Task 1's `index.css` definitions and `tailwind.config.js`'s `withOpacity('--ink-900')` references.
