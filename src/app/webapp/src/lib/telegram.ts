/**
 * Тонкая обёртка над Telegram WebApp SDK (window.Telegram.WebApp).
 * Форсим тёмно-морскую тему — НЕ наследуем тему клиента.
 */

interface TelegramWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  colorScheme?: string;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy') => void;
    selectionChanged: () => void;
  };
  openLink?: (url: string) => void;
  openTelegramLink?: (url: string) => void;
}

interface TelegramNamespace {
  WebApp?: TelegramWebApp;
}

declare global {
  interface Window {
    Telegram?: TelegramNamespace;
  }
}

function getWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

/** Инициализация на старте приложения. */
export function initTelegram(): void {
  const wa = getWebApp();
  if (!wa) return;
  try {
    wa.ready();
    wa.expand();
    // Форсим собственную тёмно-морскую тему.
    wa.setHeaderColor?.('#0B2926');
    wa.setBackgroundColor?.('#0B2926');
  } catch {
    /* в браузере вне Telegram — игнорируем */
  }
}

/** initData для заголовка X-Telegram-Init-Data. */
export function getInitData(): string {
  return getWebApp()?.initData ?? '';
}

export function hapticSelection(): void {
  getWebApp()?.HapticFeedback?.selectionChanged();
}

/** Открыть ссылку из чата: через Telegram, иначе в новой вкладке браузера. */
export function openLink(url: string): void {
  const wa = getWebApp();
  const isTelegramLink = /^https?:\/\/(t\.me|telegram\.me)\//i.test(url);
  try {
    if (wa && isTelegramLink && wa.openTelegramLink) {
      wa.openTelegramLink(url);
      return;
    }
    if (wa?.openLink) {
      wa.openLink(url);
      return;
    }
  } catch {
    /* вне Telegram — падаем на window.open */
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
