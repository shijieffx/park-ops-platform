import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    // 绑定 0.0.0.0 并放开 Host 校验：部署到反向代理后面时，否则会报
    // "Blocked request. This host is not allowed."
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 第三方依赖单独分包，避免单包过大
        manualChunks: {
          vue: ['vue', 'vue-router', 'pinia'],
          'naive-ui': ['naive-ui'],
          echarts: ['echarts'],
          exceljs: ['exceljs']
        }
      }
    }
  }
})
