import { Bot } from 'grammy';
import { config } from '../config.js';
import type { BotContextWithSession } from './middleware/session.js';
import { authMiddleware } from './middleware/auth.js';
import { sessionMiddleware } from './middleware/session.js';
import { errorHandler } from './middleware/error.js';

// Handlers
import { handleStart, handleHelp, handleCancel } from './handlers/start.js';
import {
  handleTextMessage,
  handleVoiceMessage,
  handleDocumentMessage,
  handleTxCallback,
} from './handlers/add.js';
import { handleImport, handleImportSource, handleImportCallback } from './handlers/import.js';
import { handleReport, handleReportCallback } from './handlers/report.js';
import { handleFunds, handleFundCallback } from './handlers/funds.js';
import { handleDistribute, handleDistCallback } from './handlers/distribute.js';
import { handleVerify, handleVerifyCallback } from './handlers/verify.js';
import { handleSettings, handleSettingsCallback, handleNavCallback } from './handlers/settings.js';

/**
 * Создаёт и настраивает экземпляр бота grammY.
 *
 * Порядок middleware критичен:
 *   1. authMiddleware — whitelist-проверка telegram_id, заполняет ctx.user.
 *   2. sessionMiddleware() — навешивает ctx.session (get/set/clear), хранит FSM в БД.
 *
 * Глобальные ошибки перехватываются через bot.catch(errorHandler).
 */
export function createBot(): Bot<BotContextWithSession> {
  const bot = new Bot<BotContextWithSession>(config.BOT_TOKEN);

  // ── Middleware (порядок критичен) ────────────────────────────────────────
  bot.use(authMiddleware);
  bot.use(sessionMiddleware());

  // ── Базовые команды (все роли) ───────────────────────────────────────────
  bot.command('start', handleStart);
  bot.command('help', handleHelp);
  bot.command('cancel', handleCancel);

  // ── Функциональные команды (все роли — роль не ограничивает доступ) ──────
  bot.command('import', handleImport);
  bot.command('report', handleReport);
  bot.command('funds', handleFunds);
  bot.command('distribute', handleDistribute);
  bot.command('verify', handleVerify);
  bot.command('settings', handleSettings);

  // ── Свободный ввод → add handler ────────────────────────────────────────
  // Свободный текст и голос → классификация транзакций.
  // Документы → подсказка использовать /import.
  bot.on('message:text', handleTextMessage);
  bot.on('message:voice', handleVoiceMessage);
  bot.on('message:document', handleDocumentMessage);

  // ── Callback queries (по паттернам callback_data) ────────────────────────
  // tx:confirm:<tempId> | tx:edit:<tempId> | tx:cancel:<tempId>
  // tx:editfield:<field>:<tempId> | tx:clarify:<field>:<value>:<tempId>
  bot.callbackQuery(/^tx:/, handleTxCallback);

  // verify:approve:<txId> | verify:reject:<txId> | verify:skip:<txId>
  bot.callbackQuery(/^verify:/, handleVerifyCallback);

  // report:direction:<id|all> | report:period:<period>
  bot.callbackQuery(/^report:/, handleReportCallback);

  // fund:distribute | fund:history | fund:settings
  bot.callbackQuery(/^fund:/, handleFundCallback);

  // dist:execute:<txId> | dist:custom:<txId> | dist:skip:<txId>
  bot.callbackQuery(/^dist:/, handleDistCallback);

  // import:confirm | import:cancel | import:retry
  bot.callbackQuery(/^import:source:/, handleImportSource);
  bot.callbackQuery(/^import:/, handleImportCallback);

  // cat:select:<categoryId> | cat:prev:<page> | cat:next:<page> | cat:noop
  bot.callbackQuery(/^cat:/, async (ctx) => {
    // cat:noop — кнопка "N / M" (текущая страница), ничего не делаем
    if (ctx.callbackQuery.data === 'cat:noop') {
      await ctx.answerCallbackQuery();
      return;
    }
    // Остальные cat: callback-ы обрабатываются внутри конкретных conversations/handlers
    // TODO: подключить обработку в add handler при реализации FSM-диалога
    await ctx.answerCallbackQuery();
  });

  // settings:edit:<key> | settings:users | settings:back
  bot.callbackQuery(/^settings:/, handleSettingsCallback);

  // nav:back | nav:home | nav:* — навигация между экранами
  bot.callbackQuery(/^nav:/, handleNavCallback);

  // ── Глобальный error handler ─────────────────────────────────────────────
  bot.catch(errorHandler);

  return bot;
}
