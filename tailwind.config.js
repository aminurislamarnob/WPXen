/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        // macOS System Settings palette. All theme-dependent colors resolve
        // through CSS variables (see src/index.css) so the whole app flips
        // between light and dark with prefers-color-scheme, which the main
        // process drives via nativeTheme.themeSource (Auto/Light/Dark).
        //
        // The gray scale is remapped too: in dark mode it inverts (gray-900
        // stays "primary text", gray-50 stays "subtle fill"), so the many
        // existing text-gray-*/bg-gray-* utilities adapt automatically.
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)', // selection blue
          hover: 'rgb(var(--accent-hover) / <alpha-value>)',
        },
        gray: {
          50: 'rgb(var(--gray-50) / <alpha-value>)',
          100: 'rgb(var(--gray-100) / <alpha-value>)',
          200: 'rgb(var(--gray-200) / <alpha-value>)',
          300: 'rgb(var(--gray-300) / <alpha-value>)',
          400: 'rgb(var(--gray-400) / <alpha-value>)',
          500: 'rgb(var(--gray-500) / <alpha-value>)',
          600: 'rgb(var(--gray-600) / <alpha-value>)',
          700: 'rgb(var(--gray-700) / <alpha-value>)',
          800: 'rgb(var(--gray-800) / <alpha-value>)',
          900: 'rgb(var(--gray-900) / <alpha-value>)',
        },
        wp: {
          blue: 'rgb(var(--accent) / <alpha-value>)',
          'blue-dark': 'rgb(var(--accent-hover) / <alpha-value>)',
          'blue-light': '#3b82f6',
          green: '#28c840', // macOS system green
          red: '#ff3b30',
          yellow: '#ffcc00',
          orange: '#ff9500',
        },
        sidebar: {
          DEFAULT: 'rgb(var(--sidebar) / <alpha-value>)', // translucent sidebar
          hover: 'rgb(var(--sidebar-hover) / <alpha-value>)',
          active: 'rgb(var(--accent) / <alpha-value>)',
          text: '#3d3d3d',
          'text-active': '#ffffff',
        },
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)', // window content background
          card: 'rgb(var(--surface-card) / <alpha-value>)', // grouped card background
          border: 'rgb(var(--surface-border) / <alpha-value>)',
          hairline: 'rgb(var(--surface-hairline) / <alpha-value>)', // row dividers inside cards
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
        card: 'var(--shadow-card)',
        'card-hover': 'var(--shadow-card-hover)',
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
