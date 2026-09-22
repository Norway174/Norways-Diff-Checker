import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [react()],
  root: 'renderer',
  base: './',
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync('package.json', 'utf8')).version) },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 20 },
            { name: 'highlight', test: /node_modules[\\/]highlight\.js[\\/]/, priority: 10 }
          ]
        }
      }
    }
  }
});
