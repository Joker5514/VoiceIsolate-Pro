/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg': '#0c0c10',
        'surface': '#16161c',
        'surface2': '#1e1e26',
        'accent': '#dc2626',
        'accent2': '#ef4444',
        'text': '#f0f0f2',
        'dim': '#888888',
      },
    },
  },
  plugins: [],
};
