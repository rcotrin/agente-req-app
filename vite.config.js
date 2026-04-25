import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/anthropic": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/anthropic/, ""),
      },
      "/openai": {
        target: "https://api.openai.com",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/openai/, ""),
      },
      "/devops": {
        target: "https://dev.azure.com",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/devops/, ""),
      },
    },
  },
})
