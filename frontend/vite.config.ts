import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 说明：这里刻意不配 server.proxy。
// 前端就是要跨域访问后端，走代理会把 CORS 问题掩盖掉，
// 等部署到 Vercel 才暴露出来就晚了。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
})
