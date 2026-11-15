import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  // Scope the dependency scanner to our own entry. Without this, Vite globs
  // **/*.html and crawls the reference/superset-main checkout, failing on its
  // uninstalled imports.
  optimizeDeps: {
    entries: ['index.html'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          // The 3D office pulls in three.js and R3F; splitting them keeps the
          // main bundle inspectable and lets the chunk cache independently.
          three: ['three', 'three-stdlib', '@react-three/fiber', '@react-three/drei'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
