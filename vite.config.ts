import { defineConfig } from 'vite';
const host = {
  host: '0.0.0.0',
  port: Number(process.env.PORT) || 5173,
  strictPort: Boolean(process.env.PORT),
  allowedHosts: true as const,
};
export default defineConfig({
  server: host,
  preview: host,
  build: { target: 'es2022', chunkSizeWarningLimit: 5000 },
});
