import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
export default defineConfig({
    build: {
        outDir: './dist',
        emptyOutDir: true,
        target: 'es2022',
    },
    plugins: [react(), wasm()],
    server: {
        port: 5173,
        host: true,
    },
});
