import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initTelegram } from './lib/telegram';
import { App } from './App';
import './index.css';

// Инициализация Telegram WebApp: ready/expand + форс тёмно-морской темы.
initTelegram();

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
