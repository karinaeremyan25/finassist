// POST /api/webapp/ai/chat — alias для /api/ai-chat (тот же обработчик).
import { aiChatHandler } from '../../../dist/server/routes/aiChat.js';
import { toVercel } from '../../_lib/adapter.js';

export default toVercel(aiChatHandler);
