import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is proxied rather than called cross-origin, so the browser
    // makes same-origin requests in development and there is no CORS
    // configuration to get wrong or to differ from production.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
});
