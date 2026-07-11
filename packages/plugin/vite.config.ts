import { defineConfig } from 'vite';
import { resolve } from 'path';

// Figma plugins need code.js and ui.html built separately.
// Run two builds: one for the plugin code, one for the UI.
// Controlled by BUILD_TARGET env var (set in package.json scripts).
const target = process.env.BUILD_TARGET;

export default defineConfig(
  target === 'ui'
    ? {
        // Build the UI as a self-contained HTML file
        build: {
          outDir: 'dist',
          emptyOutDir: false,
          rollupOptions: {
            input: { ui: resolve(__dirname, 'ui/index.html') },
            output: { entryFileNames: 'ui-assets/[name].js' },
          },
        },
      }
    : {
        // Build the plugin code as an IIFE
        build: {
          outDir: 'dist',
          emptyOutDir: false,
          lib: {
            entry: resolve(__dirname, 'src/code.ts'),
            name: 'plugin',
            fileName: () => 'code.js',
            formats: ['iife'],
          },
          rollupOptions: {
            output: { inlineDynamicImports: true },
          },
        },
      }
);
