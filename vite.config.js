import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// base: './' 使构建产物可被 Electron 以 file:// 协议加载
export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    port: 5173,
    host: true
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500
  }
})
