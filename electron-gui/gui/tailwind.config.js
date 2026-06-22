/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,ts,tsx}'],
  theme: {
    extend: {
      fontSize: {
        xs:   ['13px', { lineHeight: '1.5' }],
        sm:   ['14px', { lineHeight: '1.6' }],
        base: ['15px', { lineHeight: '1.6' }],
        lg:   ['17px', { lineHeight: '1.5' }],
      },
    },
  },
  plugins: [],
}
