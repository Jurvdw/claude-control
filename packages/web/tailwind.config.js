/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Claude Code palette — deep charcoal/grey + warm orange accent.
        ink: {
          900: '#141311',
          850: '#1a1915',
          800: '#211f1a',
          750: '#28251f',
          700: '#332f28',
          600: '#413c33',
          500: '#5a544a',
        },
        cream: {
          50: '#faf9f5',
          100: '#f3f1ea',
          200: '#e6e2d6',
          400: '#b8b2a4',
        },
        clay: {
          DEFAULT: '#d97757',
          400: '#e08a6d',
          500: '#d97757',
          600: '#c25f3f',
          700: '#a04a30',
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
