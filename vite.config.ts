import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        '@ide': path.resolve(__dirname, 'src/ide'),
        '@auth': path.resolve(__dirname, 'src/auth'),
      },
    },
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '2.0.0'),
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      // Requests arrive via the Cloudflare tunnel with a public Host header
      // (openhub.overlay365.com). Vite's dev server blocks unknown Hosts with a
      // 403 by default; allow the fleet domain (and local dev hosts).
      allowedHosts: ['.overlay365.com', 'localhost', '127.0.0.1'],
      proxy: {
        '/api': { target: 'http://localhost:3000', changeOrigin: true },
      },
      hmr: process.env.DISABLE_HMR !== 'true',
    },
    build: {
      target: 'esnext',
      sourcemap: process.env.NODE_ENV !== 'production',
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom', 'react-router-dom'],
            editor: ['@monaco-editor/react'],
            charts: ['recharts'],
            motion: ['motion'],
            query: ['@tanstack/react-query'],
            icons: ['lucide-react'],
            forms: ['react-hook-form', 'zod'],
            terminal: ['xterm', 'xterm-addon-fit'],
            three: ['three', '@react-three/fiber', '@react-three/drei', 'react-force-graph-3d'],
          },
        },
      },
    },
    preview: {
      port: 3000,
      headers: {
        'Content-Security-Policy': [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https: blob:",
          "font-src 'self' data:",
          "connect-src 'self' https://generativelanguage.googleapis.com https://api.github.com https://openrouter.ai https://api.deepseek.com https://*.supabase.co wss: ws:",
          "frame-src 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
        'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      },
    },
  };
});
