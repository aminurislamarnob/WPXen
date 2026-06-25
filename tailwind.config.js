/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        wp: {
          blue: '#0073aa',
          'blue-dark': '#005177',
          'blue-light': '#00a0d2',
          green: '#46b450',
          red: '#dc3232',
          yellow: '#ffb900',
          orange: '#f56e28',
        },
        sidebar: {
          DEFAULT: '#1d2327',
          hover: '#2c3338',
          active: '#2271b1',
          text: '#a7aaad',
          'text-active': '#ffffff',
        },
        surface: {
          DEFAULT: '#f0f0f1',
          card: '#ffffff',
          border: '#dcdcde',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          '"Segoe UI"',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: ['"SF Mono"', '"Fira Code"', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 3px 0 rgba(0,0,0,0.07), 0 1px 2px 0 rgba(0,0,0,0.05)',
        'card-hover': '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)',
        window: '0 20px 60px rgba(0,0,0,0.3)',
      },
      animation: {
        'spin-slow': 'spin 2s linear infinite',
        'pulse-dot': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.2s ease-out',
        'slide-in': 'slideIn 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(-4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideIn: {
          '0%': { opacity: '0', transform: 'translateX(-8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
};
