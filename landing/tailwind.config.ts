import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Telegram dark theme palette (for the LivePhone mockup).
        tg: {
          bg: "#0e1621",
          header: "#17212b",
          incoming: "#1e2c3a",
          outgoing: "#2b5278",
          link: "#6ab7ff",
          muted: "#7d8e98",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      keyframes: {
        "pulse-glow": {
          "0%, 100%": { opacity: "0.4" },
          "50%": { opacity: "0.75" },
        },
      },
      animation: {
        "pulse-glow": "pulse-glow 6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
