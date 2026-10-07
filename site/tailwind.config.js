/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Closed palette: no colours outside these tokens.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#FFFFFF',
      forest: {
        900: '#08301C', // darkest — white on it: 14.5:1
        700: '#14502F', // white on it: 9.5:1
        600: '#1B5C36', // numbers band mid stop — white on it: 7.9:1
        500: '#3B8A55', // white on it: 4.24:1 → large text only (≥24px, or ≥19px bold)
        300: '#8FC58B',
        250: '#9FCE96', // how-it-works gradient end
        200: '#C9E2BF', // how-it-works gradient
        100: '#DCEBD4',
        50: '#EEF6E9', // lightest
      },
      ink: '#0F1A12',
      muted: '#4A5A4E', // on white: 7.3:1
      sage: '#6E8672', // on white: 3.95:1 → large text or decoration only
      rule: '#DCE8D6', // borders
    },
    fontFamily: {
      // Headings and figures. Thmanyah Sans is local-only (see vite.config.ts); where its files are
      // absent (fresh clone, CI, the published site), Reem Kufi from Google Fonts takes over.
      display: ['"Thmanyah Sans"', '"Reem Kufi"', '"IBM Plex Sans Arabic"', 'Tahoma', 'sans-serif'],
      // Body text
      sans: ['"IBM Plex Sans Arabic"', '"Segoe UI"', 'Tahoma', 'sans-serif'],
      mono: ['"IBM Plex Mono"', 'ui-monospace', 'Consolas', 'monospace'],
    },
    extend: {
      maxWidth: {
        page: '1200px',
      },
    },
  },
  plugins: [],
}
