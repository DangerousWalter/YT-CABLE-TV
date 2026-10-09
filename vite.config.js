import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Older browsers (Samsung TVs run a Chromium from 2021-2022) can't read the newest JavaScript syntax
  build: { target: 'chrome85' },
  server: {
    port: 5173,
    // `npm run dev` + `npm run server`: the page talks to /api on its own address, and Vite forwards it to the server
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
});
