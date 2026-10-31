module.exports = {
  content: ['./client/**/*.{js,jsx}', './customer-app/**/*.{js,jsx,html}', './staff-app/**/*.{js,jsx,html}'],

    theme: {
      extend: {
        colors: {
          cream: '#FAF8F5', ink: '#1A1A1A', sand: '#F2EDE5', line: '#E7DFD3', muted: '#6E665C',
          gold: { DEFAULT: '#C89547', dark: '#9E7330', light: '#E9D6B0', wash: '#F7EEDF' },
          veg: '#2F7D4F', nonveg: '#A23B2A',
        },
        fontFamily: {
          serif: ['"Playfair Display"', 'Georgia', '"Times New Roman"', 'serif'],
          sans: ['"Plus Jakarta Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
          mono: ['"JetBrains Mono"', 'ui-monospace', 'Menlo', 'monospace'],
        },
      },
    },
  
};
