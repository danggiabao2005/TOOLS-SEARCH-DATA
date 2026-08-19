/** @type {import('tailwindcss').Config} */
export default {
  content: ["./popup.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f4f7f5",
          100: "#e4ebe6",
          200: "#c8d6cc",
          700: "#2f4638",
          800: "#1e2f26",
          900: "#142019",
        },
        pico: {
          p: "#0d7377",
          i: "#c45c26",
          c: "#3d5a80",
          o: "#6b4c9a",
        },
        accent: {
          DEFAULT: "#1a6b5c",
          soft: "#d4ebe4",
        },
      },
      fontFamily: {
        display: ['"Source Serif 4"', "Georgia", "serif"],
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      boxShadow: {
        panel: "0 12px 40px rgba(20, 32, 25, 0.12)",
      },
    },
  },
  plugins: [],
};
