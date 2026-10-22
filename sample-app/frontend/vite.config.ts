// =============================================================================
// vite.config.ts — Week 8 frontend
// -----------------------------------------------------------------------------
// • React plugin enables JSX + Fast Refresh.
// • vite-plugin-pwa registers a service worker and emits the manifest, which
//   is what makes this app installable / offline-capable (lecture §10–§12).
// • Dev-server proxy forwards /api, /hubs, /ws and /mcp to the .NET backend on
//   :5090 so the SPA can talk to it via same-origin URLs (no CORS pain
//   during dev).
// =============================================================================
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api':  { target: 'http://127.0.0.1:5090', changeOrigin: true },
      // SignalR + WebSocket need ws upgrade forwarded too.
      '/hubs': { target: 'http://127.0.0.1:5090', changeOrigin: true, ws: true },
      '/ws':   { target: 'http://127.0.0.1:5090', changeOrigin: true, ws: true },
      // Exact match only: the SPA's own page lives at /mcp-demo and must not be proxied.
      '^/mcp$': { target: 'http://127.0.0.1:5090', changeOrigin: true },
    },
  },
  plugins: [
    react(),
    VitePWA({
      // `autoUpdate` regenerates the service worker on each build so students
      // can deploy a new version without dealing with the "Update available"
      // banner pattern.
      registerType: 'autoUpdate',

      // We deliberately use the *injectManifest* strategy in this teaching app
      // so students can read our hand-written service worker (src/sw.ts). The
      // default 'generateSW' would hide that code behind workbox magic.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: {
        // Limit precache to standard SPA assets.
        globPatterns: ['**/*.{js,css,html,svg,ico,png,webmanifest}'],
      },

      // Web App Manifest — name, icons, theme.
      manifest: {
        name: 'Realtime Demo (Week 8)',
        short_name: 'RT Demo',
        description: 'Reference application for Week 8: real-time web technologies & PWAs.',
        theme_color: '#0e1015',
        background_color: '#0e1015',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      devOptions: {
        enabled: true,  // serve a working SW in `npm run dev` so the PWA demo works there too
        type: 'module',
      },
    }),
  ],
});
