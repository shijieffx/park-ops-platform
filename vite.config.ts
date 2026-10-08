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
    // 显式绑定 IPv4：默认只监听 ::1 时，用 127.0.0.1 打不开
    host: '127.0.0.1',
    port: 5173,
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
