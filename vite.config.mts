import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';

const gitCommit = (() => {
  try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return 'development'; }
})();

export default defineConfig({
  plugins: [react()],
  root: 'renderer',
  base: './',
  define: { __APP_COMMIT__: JSON.stringify(gitCommit) },
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'spreadsheet', test: /node_modules[\\/]xlsx[\\/]/, priority: 30 },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 20 },
            { name: 'highlight', test: /node_modules[\\/]highlight\.js[\\/]/, priority: 10 }
          ]
        }
      }
    }
  }
});