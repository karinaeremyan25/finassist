/**
 * /api/admin/users — CRUD управления пользователями.
 *
 * Доступен ТОЛЬКО роли owner.
 *
 * GET    → список всех пользователей (включая pending и неактивных, кроме deleted_at)
 * POST   → добавить pending-пользователя по @username
 * PATCH  → изменить роль / isActive
 * DELETE → soft delete (deleted_at = NOW())
 *
 * Защиты:
 *  - нельзя деактивировать / разжаловать / удалить себя (owner)
 *  - нельзя убрать последнего owner
 *
 * Все запросы к БД строго последовательны (pgBouncer transaction mode).
 */

import { z } from 'zod';
import { resolveWebAppUser, unauthorizedResponse, WebAppAuthError } from '../auth.js';
import {
  getAllUsersForAdmin,
  addPendingUser,
  updateUserRoleActive,
  softDeleteUser,
  countActiveOwners,
} from '../../db/repositories/users.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'admin_users' });

// ── Zod-схемы для тел запросов ────────────────────────────────────────────

const RoleSchema = z.enum(['owner', 'accountant', 'manager']);

const PostBodySchema = z.object({
  username: z.string().min(1, 'username обязателен'),
  role: RoleSchema.default('manager'),
});

const PatchBodySchema = z.object({
  id: z.string().uuid('id должен быть UUID'),
  isActive: z.boolean().optional(),
  role: RoleSchema.optional(),
});

const DeleteBodySchema = z.object({
  id: z.string().uuid('id должен быть UUID'),
});

// ── Вспомогательная функция: форматирование пользователя для ответа ────────

function formatUser(u: {
  id: string;
  username: string | null;
  fullName: string | null;
  role: string;
  isActive: boolean;
  telegramId: bigint | null;
  lastSeen: Date | null;
  pending: boolean;
}) {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    role: u.role,
    isActive: u.isActive,
    // bigint → string, чтобы JSON не терял точность на фронте
    telegramId: u.telegramId !== null ? u.telegramId.toString() : null,
    lastSeen: u.lastSeen !== null ? u.lastSeen.toISOString() : null,
    pending: u.pending,
  };
}

// ── Обработчик ────────────────────────────────────────────────────────────

export const adminUsersHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const start = Date.now();

  try {
    // Авторизация: только owner
    const user = await resolveWebAppUser(req);

    if (user.role !== 'owner') {
      return {
        status: 403,
        body: {
          error: {
            code: 'forbidden',
            message: 'Только владелец может управлять пользователями',
          },
        },
      };
    }

    // ── GET ─────────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const users = await getAllUsersForAdmin();

      log.info(
        {
          telegram_id: user.telegramId.toString(),
          handler: 'admin_users_get',
          count: users.length,
          latency_ms: Date.now() - start,
        },
        'admin_users_get_ok'
      );

      return {
        status: 200,
        body: { users: users.map(formatUser) },
      };
    }

    // ── POST ────────────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const parsed = PostBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return {
          status: 400,
          body: { error: { code: 'validation_error', message: parsed.error.errors[0]?.message ?? 'Невалидные данные' } },
        };
      }

      // Нормализуем username: убираем ведущий @, trim; регистр сохраняем как есть
      const rawUsername = parsed.data.username.trim();
      const username = rawUsername.startsWith('@') ? rawUsername.slice(1) : rawUsername;

      if (username.length === 0) {
        return {
          status: 400,
          body: { error: { code: 'validation_error', message: 'username не может быть пустым' } },
        };
      }

      // Проверяем отсутствие дубликата (case-insensitive, только активные и pending)
      const allUsers = await getAllUsersForAdmin();
      const duplicate = allUsers.find(
        (u) => u.username !== null && u.username.toLowerCase() === username.toLowerCase()
      );
      if (duplicate !== undefined) {
        return {
          status: 409,
          body: {
            error: {
              code: 'conflict',
              message: `Пользователь @${username} уже существует`,
            },
          },
        };
      }

      const created = await addPendingUser({ username, role: parsed.data.role });

      log.info(
        {
          telegram_id: user.telegramId.toString(),
          handler: 'admin_users_post',
          new_username: username,
          latency_ms: Date.now() - start,
        },
        'admin_users_post_ok'
      );

      return {
        status: 201,
        body: { user: formatUser(created) },
      };
    }

    // ── PATCH ───────────────────────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const parsed = PatchBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return {
          status: 400,
          body: { error: { code: 'validation_error', message: parsed.error.errors[0]?.message ?? 'Невалидные данные' } },
        };
      }

      const { id, isActive, role } = parsed.data;

      // Нельзя изменять самого себя
      if (id === user.id) {
        return {
          status: 400,
          body: {
            error: {
              code: 'self_modification',
              message: 'Нельзя изменять собственные права доступа',
            },
          },
        };
      }

      // Если пытаемся снизить роль с owner или деактивировать — проверяем, не последний ли
      const isDowngradingOwner = role !== undefined && role !== 'owner';
      const isDeactivating = isActive === false;

      if (isDowngradingOwner || isDeactivating) {
        // Найдём целевого пользователя
        const allUsers = await getAllUsersForAdmin();
        const target = allUsers.find((u) => u.id === id);

        if (target !== undefined && target.role === 'owner') {
          const ownersCount = await countActiveOwners();
          if (ownersCount <= 1) {
            return {
              status: 400,
              body: {
                error: {
                  code: 'last_owner',
                  message: 'Нельзя убрать последнего owner',
                },
              },
            };
          }
        }
      }

      const updated = await updateUserRoleActive({ id, isActive, role });

      log.info(
        {
          telegram_id: user.telegramId.toString(),
          handler: 'admin_users_patch',
          target_id: id,
          latency_ms: Date.now() - start,
        },
        'admin_users_patch_ok'
      );

      return {
        status: 200,
        body: { user: formatUser(updated) },
      };
    }

    // ── DELETE ──────────────────────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const parsed = DeleteBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return {
          status: 400,
          body: { error: { code: 'validation_error', message: parsed.error.errors[0]?.message ?? 'Невалидные данные' } },
        };
      }

      const { id } = parsed.data;

      // Нельзя удалить себя
      if (id === user.id) {
        return {
          status: 400,
          body: {
            error: {
              code: 'self_modification',
              message: 'Нельзя удалить собственный аккаунт',
            },
          },
        };
      }

      // Нельзя удалить последнего owner
      const allUsers = await getAllUsersForAdmin();
      const target = allUsers.find((u) => u.id === id);
      if (target !== undefined && target.role === 'owner') {
        const ownersCount = await countActiveOwners();
        if (ownersCount <= 1) {
          return {
            status: 400,
            body: {
              error: {
                code: 'last_owner',
                message: 'Нельзя удалить последнего owner',
              },
            },
          };
        }
      }

      await softDeleteUser(id);

      log.info(
        {
          telegram_id: user.telegramId.toString(),
          handler: 'admin_users_delete',
          target_id: id,
          latency_ms: Date.now() - start,
        },
        'admin_users_delete_ok'
      );

      return {
        status: 200,
        body: { success: true },
      };
    }

    // ── Метод не поддерживается ─────────────────────────────────────────────
    return {
      status: 405,
      body: { error: { code: 'method_not_allowed', message: 'Метод не поддерживается' } },
    };
  } catch (err) {
    if (err instanceof WebAppAuthError) return unauthorizedResponse(err.reason);

    log.error(
      { err, handler: 'admin_users', latency_ms: Date.now() - start },
      'admin_users_error'
    );
    throw err;
  }
};
