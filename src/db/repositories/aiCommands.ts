/**
 * Репозиторий лога команд AI-оркестратора (SPEC_FinAssist_v2.1 US-105).
 * Каждая команда сохраняется до выполнения (статус pending), затем обновляется
 * после approve/reject (executed/failed/rejected). Запросы последовательны.
 */

import { sql } from '../client.js';

export type CommandType = 'create_invoice' | 'create_payment' | 'reclassify' | 'query' | 'unknown';
export type CommandStatus = 'pending' | 'executed' | 'failed' | 'rejected';

export interface AiCommandRow {
  id: string;
  commandText: string;
  commandType: CommandType;
  status: CommandStatus;
  aiResponse: unknown;
  result: unknown;
  createdAt: string;
}

interface AiCommandRaw {
  id: string;
  command_text: string;
  command_type: CommandType;
  status: CommandStatus;
  ai_response: unknown;
  result: unknown;
  created_at: string;
}

function mapRow(r: AiCommandRaw): AiCommandRow {
  return {
    id: r.id,
    commandText: r.command_text,
    commandType: r.command_type,
    status: r.status,
    aiResponse: r.ai_response,
    result: r.result,
    createdAt: r.created_at,
  };
}

/** Логирует команду со структурированным разбором AI. Возвращает её id. */
export async function logCommand(input: {
  userId: string | null;
  commandText: string;
  commandType: CommandType;
  status: CommandStatus;
  aiResponse: unknown;
}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO ai_commands (user_id, command_text, command_type, status, ai_response)
    VALUES (
      ${input.userId}::uuid, ${input.commandText}, ${input.commandType},
      ${input.status}, ${sql.json(input.aiResponse as never)}
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

/** Возвращает команду по id (или null). */
export async function getCommand(id: string): Promise<AiCommandRow | null> {
  const rows = await sql<AiCommandRaw[]>`
    SELECT id, command_text, command_type, status, ai_response, result, created_at::text AS created_at
    FROM ai_commands
    WHERE id = ${id}::uuid
  `;
  const r = rows[0];
  return r === undefined ? null : mapRow(r);
}

/** Обновляет статус и результат выполнения команды. */
export async function finalizeCommand(
  id: string,
  status: CommandStatus,
  result: unknown
): Promise<void> {
  await sql`
    UPDATE ai_commands
    SET status = ${status}, result = ${sql.json(result as never)}, updated_at = NOW()
    WHERE id = ${id}::uuid
  `;
}

/** История команд пользователя (последние N). */
export async function listCommands(userId: string, limit = 30): Promise<AiCommandRow[]> {
  const rows = await sql<AiCommandRaw[]>`
    SELECT id, command_text, command_type, status, ai_response, result, created_at::text AS created_at
    FROM ai_commands
    WHERE user_id = ${userId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map(mapRow);
}
