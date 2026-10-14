import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
// Self-hosted Monaco first: replaces the CDN loader (blocked by CSP) before
// any editor mounts. Side-effect import by design.
import './ide/monacoSetup';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
