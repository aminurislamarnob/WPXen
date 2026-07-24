/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        // Superset-style semantic palette. Every theme-dependent color resolves
        // through a CSS variable (see src/index.css) so the whole app flips with
        // prefers-color-scheme, which follows the macOS system appearance.
        //
        // NOTE: `accent` is the *neutral hover fill* (shadcn semantics), NOT the
        // brand blue. The brand blue is `highlight`.
        background: 'rgb(var(--background) / <alpha-value>)',
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        card: {
          DEFAULT: 'rgb(var(--card) / <alpha-value>)',
          foreground: 'rgb(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'rgb(var(--popover) / <alpha-value>)',
          foreground: 'rgb(var(--popover-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'rgb(var(--primary) / <alpha-value>)',
          foreground: 'rgb(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'rgb(var(--secondary) / <alpha-value>)',
          foreground: 'rgb(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'rgb(var(--muted) / <alpha-value>)',
          foreground: 'rgb(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          foreground: 'rgb(var(--accent-foreground) / <alpha-value>)',
        },
        tertiary: {
          DEFAULT: 'rgb(var(--tertiary) / <alpha-value>)',
          active: 'rgb(var(--tertiary-active) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'rgb(var(--destructive) / <alpha-value>)',
          foreground: 'rgb(var(--destructive-foreground) / <alpha-value>)',
        },
        border: 'rgb(var(--border) / <alpha-value>)',
        input: 'rgb(var(--input) / <alpha-value>)',
        ring: 'rgb(var(--ring) / <alpha-value>)',
        sidebar: {
          DEFAULT: 'rgb(var(--sidebar) / <alpha-value>)',
          foreground: 'rgb(var(--sidebar-foreground) / <alpha-value>)',
          accent: 'rgb(var(--sidebar-accent) / <alpha-value>)',
          border: 'rgb(var(--sidebar-border) / <alpha-value>)',
          active: 'rgb(var(--highlight) / <alpha-value>)', // blue selection pill
        },
        // Brand blue — cursor, selections, active pill, toggles, links.
        highlight: {
          DEFAULT: 'rgb(var(--highlight) / <alpha-value>)',
          foreground: 'rgb(var(--highlight-foreground) / <alpha-value>)',
        },
        status: {
          running: 'rgb(var(--status-running) / <alpha-value>)',
          warning: 'rgb(var(--status-warning) / <alpha-value>)',
          error: 'rgb(var(--status-error) / <alpha-value>)',
        },

        // ── Migration shims (deprecated; removed once the page sweep lands) ──
        // The gray ramp inverts in dark mode, so gray-900 is always "primary
        // text" and gray-50 always "subtle fill". Prefer foreground /
        // muted-foreground / muted in new code.
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
        surface: {
          DEFAULT: 'rgb(var(--background) / <alpha-value>)',
          card: 'rgb(var(--card) / <alpha-value>)',
          border: 'rgb(var(--border) / <alpha-value>)',
          hairline: 'rgb(var(--border) / <alpha-value>)',
        },
        wp: {
          blue: 'rgb(var(--highlight) / <alpha-value>)',
          'blue-dark': 'rgb(var(--highlight) / <alpha-value>)',
          'blue-light': 'rgb(var(--highlight) / <alpha-value>)',
          green: 'rgb(var(--status-running) / <alpha-value>)',
          red: 'rgb(var(--status-error) / <alpha-value>)',
          yellow: 'rgb(var(--status-warning) / <alpha-value>)',
          orange: 'rgb(var(--status-warning) / <alpha-value>)',
        },
      },
      borderRadius: {
        DEFAULT: 'var(--radius)', // 10px
        sm: 'calc(var(--radius) - 4px)', // 6px
        md: 'calc(var(--radius) - 2px)', // 8px
        lg: 'var(--radius)', // 10px
        xl: 'calc(var(--radius) + 4px)', // 14px
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
        mono: [
          '"JetBrains Mono"',
          '"SF Mono"',
          'ui-monospace',
          'Menlo',
          'Monaco',
          'monospace',
        ],
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
