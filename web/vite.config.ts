import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 应用通过飞牛统一网关挂载在 /app/omniedit 下，
// 前端资源必须以该前缀为 base，否则会出现静态资源 404。
// 详见 docs/ARCHITECTURE.md 第 4、10 节。
const BASE = '/app/omniedit/';

// 开发期后端地址（本地直接运行 Go 服务时使用）。
// NAS 上由统一网关同域转发，无需代理。
const BACKEND_TARGET = process.env.OMNIEDIT_DEV_BACKEND ?? 'http://127.0.0.1:8899';

export default defineConfig({
  base: BASE,
  plugins: [vue()],
  server: {
    // 本地开发：把 base 路径下的 API 请求代理到本地 Go 后端。
    proxy: {
      [`${BASE}api`]: {
        target: BACKEND_TARGET,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/app\/omniedit/, ''),
      },
    },
  },
  build: {
    outDir: '../app/dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 代码分割：把体积大、更新少的核心依赖拆成独立 chunk。
        // 目的：1) 浏览器并行加载更快；2) 应用代码改动时 vendor chunk 命中缓存。
        // 对 NAS 低配硬件的首屏启动尤其有意义（契合「轻量、快启动」设计目标）。
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('@codemirror') || id.includes('/codemirror/')) {
              return 'codemirror';
            }
            if (id.includes('/marked/') || id.includes('/dompurify/')) {
              return 'markdown';
            }
            if (id.includes('/vue/') || id.includes('/@vue/') || id.includes('/pinia/') || id.includes('vue-demi')) {
              return 'vue';
            }
            if (id.includes('@trimjs/web-app') || id.includes('@fn/micro-app-postmate')) {
              return 'fnos-sdk';
            }
            // 其余 node_modules 归入通用 vendor。
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
});
