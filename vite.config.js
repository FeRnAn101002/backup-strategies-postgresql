import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  optimizeDeps: { exclude: ['@electric-sql/pglite', '@electric-sql/pglite-tools'] },
  build: { target: 'es2022' },
  worker: { format: 'es' },
  test: { testTimeout: 120000, hookTimeout: 120000, fileParallelism: false },
})
