import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'

// 版本号只有 package.json 一个事实来源。注入成编译期常量，
// 渲染层（src/version.js）与快照头都用它，不必在两处手写版本号。
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// base: './' 使构建产物可被 Electron 以 file:// 协议加载
export default defineConfig({
  plugins: [vue()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  server: {
    port: 5173,
    host: true
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500
  }
})
