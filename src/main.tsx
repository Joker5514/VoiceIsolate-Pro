import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './ui/App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register service worker for PWA offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/VoiceIsolate-Pro/sw.js', { scope: '/VoiceIsolate-Pro/' })
      .catch((err) => {
        console.warn('[SW] Registration failed:', err);
      });
  });
}
