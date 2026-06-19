import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import { applyHtmlLang } from './i18n/translations';
import { useSettings } from './store/settings';

// Apply saved language on boot.
const lang = useSettings.getState().language;
applyHtmlLang(lang);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// ============================================================================
// Service Worker registration — enables offline / PWA mode.
// ============================================================================
//
// After the first visit, all assets (HTML, JS, CSS, WASM, fonts, sounds,
// images) are cached locally. Single-player and LAN P2P play then work fully
// offline — no internet required. This is critical for the hotspot use case
// (one phone acts as hotspot, others connect to it; the hotspot has no
// upstream internet so the game MUST load from cache on the guest devices).
//
// We register in `window.onload` so the SW doesn't compete with the initial
// JS bundle / WASM load for bandwidth. We also only register in production
// (Vite dev mode serves files differently and the SW would interfere with
// HMR). To test the SW in dev, run `npm run build && npm run preview`.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const isDev = import.meta.env.DEV;
    if (isDev) {
      // In dev, skip SW registration — it would cache stale dev bundles and
      // break HMR. Use `npm run preview` after a build to test the SW.
      console.log('[PWA] Skipping service worker registration in dev mode (use `npm run preview` to test offline).');
      return;
    }
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        console.log('[PWA] Service worker registered:', reg.scope);
        // Check for updates every hour. If a new SW is found, it'll be
        // installed in the background and activated on next navigation.
        setInterval(() => reg.update().catch(() => { /* ignore */ }), 60 * 60 * 1000);
      })
      .catch((err) => {
        console.warn('[PWA] Service worker registration failed:', err);
      });
  });
}
