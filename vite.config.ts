import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
    build: {
        outDir: './dist',
        emptyOutDir: true
    },
    plugins: [
        wasm()
    ]
});