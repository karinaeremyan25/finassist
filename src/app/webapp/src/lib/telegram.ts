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
