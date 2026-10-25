// First, before anything that formats numbers loads (the chart library does so on import).
import './ui/localeGuard';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './ui/Root';
import { initialTheme } from './ui/themeMode';
import './ui/theme.css';

// index.html sets the theme before first paint; this covers the case where that script didn't run.
document.documentElement.dataset.theme ??= initialTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
