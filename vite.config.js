import { defineConfig } from 'vite';

export default defineConfig({
  base: '/browser-port-experiments/',
  build: {
    target: 'es2022',
  },
});
