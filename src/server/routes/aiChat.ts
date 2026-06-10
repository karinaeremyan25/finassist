/**
 * POST /api/ai-chat  (и alias POST /api/webapp/ai/chat)
 *
 * Тонкий хендлер: валидирует тело, вызывает generateMentorAnswer,
 * возвращает { answer, source, timestamp } либо корректный код ошибки.
 */

import { z } from 'zod';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import {
  generateMentorAnswer,
  MentorError,
} from '../../services/miniAppAi.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'ai_chat' });

const AiChatBodySchema = z.object({
  question: z.string(),
  entity_id: z.string().uuid().optional().nullable(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  context: z.string().optional().nullable(),
});

function mentorErrorToResponse(err: MentorError): ApiResponse {
  const code = err.code;
  if (code === 'invalid_request') {
    return {
      status: 400,
      body: { error: { code: 'invalid_request', message: err.message } },
    };
  }
  if (code === 'insufficient_data') {
    return {
      status: 422,
      body: { error: { code: 'insufficient_data', message: err.message } },
    };
  }
  if (code === 'off_topic') {
    return {
      status: 422,
      body: { error: { code: 'off_topic', message: err.message } },
    };
  }
  // ai_unavailable
  return {
    status: 503,
    body: { error: { code: 'ai_unavailable', message: err.message } },
  };
}

export const aiChatHandler: ApiHandler = async (req) => {
  const start = Date.now();

  try {
    const user = await resolveWebAppUser(req);

    const parsed = AiChatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return {
        status: 400,
        body: { error: { code: 'invalid_request', message: 'Неверный формат запроса.' } },
      };
    }

    const { question, entity_id, from, to, context } = parsed.data;

    if (question.trim().length === 0) {
      return {
        status: 400,
        body: { error: { code: 'invalid_request', message: 'Вопрос не может быть пустым.' } },
      };
    }

    const result = await generateMentorAnswer({
      question,
      telegramId: user.telegramId,
      entityId: entity_id ?? null,
      from: from ?? null,
      to: to ?? null,
      context: context ?? null,
    });

    log.info(
      {
        telegram_id: user.telegramId.toString(),
        handler: 'ai_chat',
        latency_ms: Date.now() - start,
      },
      'ai_chat_ok'
    );

    return {
      status: 200,
      body: {
        answer: result.answer,
        source: result.source,
        timestamp: new Date().toISOString(),
      },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse();
    if (err instanceof MentorError) return mentorErrorToResponse(err);
    log.error({ err, handler: 'ai_chat', latency_ms: Date.now() - start }, 'ai_chat_error');
    throw err;
  }
};
