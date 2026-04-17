const path = require("path");

module.exports = {
  darkMode: "class",
  content: [
    path.join(__dirname, "screens/**/*.html"),
    path.join(__dirname, "screens/**/*.js"),
    path.join(__dirname, "index.html")
  ],
  theme: {
    extend: {
      colors: {
        "on-secondary": "#e6f5ff",
        "on-primary-fixed": "#000000",
        "error-dim": "#a70138",
        "on-tertiary-container": "#450087",
        "secondary-fixed": "#97daff",
        "surface-container": "#e6e8ea",
        "surface-container-high": "#e0e3e4",
        "on-primary-fixed-variant": "#230095",
        "tertiary-fixed-dim": "#bc8cff",
        error: "#b41340",
        "primary-fixed-dim": "#8e83ff",
        "inverse-surface": "#0c0f10",
        "on-primary-container": "#1b007a",
        "error-container": "#f74b6d",
        "surface-container-highest": "#dadddf",
        "on-background": "#2c2f30",
        "surface-container-lowest": "#ffffff",
        "on-tertiary-fixed": "#24004c",
        "surface-tint": "#4d2afa",
        "on-surface-variant": "#595c5d",
        tertiary: "#7a25db",
        "tertiary-container": "#c79eff",
        "surface-variant": "#dadddf",
        "surface-dim": "#d1d5d7",
        "on-surface": "#2c2f30",
        "primary-fixed": "#9c93ff",
        "tertiary-dim": "#6d09ce",
        "on-error": "#ffefef",
        "secondary-fixed-dim": "#6bcfff",
        "primary-dim": "#400aef",
        primary: "#4d2afa",
        "on-tertiary-fixed-variant": "#50009c",
        outline: "#757778",
        "on-secondary-container": "#004d68",
        "secondary-dim": "#005673",
        "inverse-on-surface": "#9b9d9e",
        "on-secondary-fixed": "#00394d",
        "on-tertiary": "#f9efff",
        "surface-bright": "#f5f6f7",
        secondary: "#006384",
        "secondary-container": "#97daff",
        background: "#f5f6f7",
        "on-secondary-fixed-variant": "#005775",
        "surface-container-low": "#eff1f2",
        "tertiary-fixed": "#c79eff",
        "outline-variant": "#abadae",
        "primary-container": "#9c93ff",
        "on-error-container": "#510017",
        "on-primary": "#f2edff",
        surface: "#f5f6f7",
        "inverse-primary": "#8b80ff"
      },
      borderRadius: {
        DEFAULT: "0.125rem",
        lg: "0.25rem",
        xl: "0.5rem",
        full: "0.75rem"
      },
      fontFamily: {
        headline: ["Manrope", "sans-serif"],
        body: ["Inter", "sans-serif"],
        label: ["Inter", "sans-serif"]
      }
    }
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries")
  ]
};
