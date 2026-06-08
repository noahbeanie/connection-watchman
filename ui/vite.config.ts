import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Builds to ../web as fully-bundled static assets (no CDN) served by the Pi's
// Python http.server. base "./" keeps asset URLs relative so they resolve at "/".
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  base: "./",
  build: { outDir: "../web", emptyOutDir: true },
})
