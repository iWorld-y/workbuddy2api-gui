import { defineConfig, type Plugin } from 'vite'
import { writeFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'

// emptyOutDir 会清空 dist，连 go:embed 的锚点 .gitkeep 一起删掉；不补回来的话，
// 每次构建都会残留一个「已删除待提交」的占位文件，容易被顺手提交成产物。
// 产物本身由 .gitignore 排除，这里只负责把锚点写回。
const keepDistAnchor = (): Plugin => ({
  name: 'keep-dist-anchor',
  closeBundle() {
    writeFileSync(new URL('../internal/webui/dist/.gitkeep', import.meta.url), '')
  },
})

// 构建产物直接落到 Go 的 embed 目录，`npm run build` 后 go build 即可打包。
// dev 模式下把 /api 代理到本地后端（默认 8787），前后端可分别热更新。
export default defineConfig({
  plugins: [react(), keepDistAnchor()],
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    // 单页应用，不需要 sourcemap 进产物（体积更小）。
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.WBGUI_BACKEND || 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
