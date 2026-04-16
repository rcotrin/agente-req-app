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
      "/devops": {
        target: "https://dev.azure.com",
        changeOrigin: true,
        rewrite: path => path.replace(/^\/devops/, ""),
      },
    },
  },
})
