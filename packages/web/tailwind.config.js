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
