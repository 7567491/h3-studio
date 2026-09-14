import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 静态构建,产物在 dist/,nginx 直接 serve。
// base: '/h3/' 让生成的资源路径都带 /h3/,方便跟其他 linapp 子域名共用静态路径
// (避免跟别的站点 CSS/JS 冲突,也方便独立部署到子目录)
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 4173,
    proxy: {
      // 开发时通过 vite proxy 转发 /api 到后端,避免 CORS
      '/api': 'http://127.0.0.1:18893',
      '/ws': { target: 'ws://127.0.0.1:18893', ws: true },
    },
  },
})
