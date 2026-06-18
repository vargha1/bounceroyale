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
