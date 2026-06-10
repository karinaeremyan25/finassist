/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: { base: '#0B2926', deep: '#0D2C29', crest: '#1F584A' },
        surface: { 1: '#143733', 2: '#1A473E', 3: '#21564B', nav: '#0A322C' },
        ink: { DEFAULT: '#F0FAF8', muted: '#8FB3AD', faint: '#5E827C' },
        accent: { DEFAULT: '#2DD4BF', soft: '#5EEAD4', ink: '#04201C' },
        income: '#34D399',
        expense: '#FB7A6E',
        warning: '#FBBF24',
        chart: {
          expense: '#FB7A6E',
          profit: '#34D399',
          fundCred: '#FBBF24',
          tax: '#94A3B8',
          fundGrat: '#38BDF8',
          track: '#123A35',
        },
        border: { DEFAULT: 'rgba(255,255,255,0.07)', strong: '#21504A' },
      },
      borderRadius: { sm: '10px', md: '16px', lg: '22px', pill: '999px' },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'SF Pro Text', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'elev-1': '0 2px 8px rgba(0,0,0,.25)',
        'elev-2': '0 8px 24px rgba(0,0,0,.35)',
        glow: '0 0 16px rgba(45,212,191,0.35)',
      },
      maxWidth: { app: '420px' },
    },
  },
  plugins: [],
};
