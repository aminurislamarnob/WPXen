/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        // macOS System Settings palette. `wp.*` names are kept as aliases so
        // existing utility classes keep compiling, but they now map to system
        // colors (accent blue, system green/red/etc.).
        accent: {
          DEFAULT: '#0a60ff', // selection blue (System Settings active pill)
          hover: '#0a55e0',
        },
        wp: {
          blue: '#0a60ff',
          'blue-dark': '#0a55e0',
          'blue-light': '#3b82f6',
          green: '#28c840', // macOS system green
          red: '#ff3b30',
          yellow: '#ffcc00',
          orange: '#ff9500',
        },
        sidebar: {
          DEFAULT: '#e7e6e8', // light translucent sidebar
          hover: '#dddcdf',
          active: '#0a60ff',
          text: '#3d3d3d',
          'text-active': '#ffffff',
        },
        surface: {
          DEFAULT: '#f5f4f6', // window content background
          card: '#ffffff', // grouped card background
          border: '#e5e4e7',
          hairline: '#e9e8ea', // row dividers inside cards
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
        card: '0 0 0 0.5px rgba(0,0,0,0.08), 0 1px 2px 0 rgba(0,0,0,0.04)',
        'card-hover': '0 0 0 0.5px rgba(0,0,0,0.1), 0 2px 6px 0 rgba(0,0,0,0.08)',
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
