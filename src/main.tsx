import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { initialTheme } from './ui/themeMode';
import './ui/theme.css';

// index.html sets the theme before first paint; this covers the case where that script didn't run.
document.documentElement.dataset.theme ??= initialTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
