// POST /api/ai-chat — AI-наставник Mini App (claude-opus-4-8 через miniAppAi).
import { aiChatHandler } from '../dist/server/routes/aiChat.js';
import { toVercel } from './_lib/adapter.js';

export default toVercel(aiChatHandler);
