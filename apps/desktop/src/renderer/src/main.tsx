import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { createHttpApi } from './api/http-api';
import { apiPath } from './api/base-path';
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
  // 网页端没有 macOS 红绿灯,顶部那条 34px 的窗口拖拽条纯属浪费(而且
  // -webkit-app-region:drag 在浏览器里无效)。给根节点挂一个标记,
  // 让 CSS 在网页档隐藏它,并把各页高度从 calc(100vh - 34px) 补回 100vh。
  // ⚠️ 这个分支只在网页构建里会走(Electron 里 preload 先把 bigbotartShell 设成 true)。
  document.documentElement.classList.add('web-shell');
  window.bigbotart = createHttpApi();
}

if (window.bigbotartShell === false) {
  void fetch(apiPath('/session'), { credentials: 'same-origin' })
    .then((res) => (res.ok ? renderApp() : renderLogin()))
    .catch(() => renderLogin());
} else {
  renderApp();
}