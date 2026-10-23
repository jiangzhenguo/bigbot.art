import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { createHttpApi } from './api/http-api';
import { RemoteLogin } from './api/RemoteLogin';
import './styles/design-pages.css';
import './styles/timeline-design.css';

const root = document.getElementById('root')!;

function renderApp() {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

function renderLogin() {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <RemoteLogin />
    </React.StrictMode>,
  );
}

if (!window.bigbotart) {
  window.bigbotartShell = false;
  window.bigbotart = createHttpApi();
}

if (window.bigbotartShell === false) {
  void fetch('/session', { credentials: 'same-origin' })
    .then((res) => (res.ok ? renderApp() : renderLogin()))
    .catch(() => renderLogin());
} else {
  renderApp();
}