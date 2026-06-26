/**
 * ВРЕМЕННЫЙ диагностический эндпоинт: GET /api/lava/probe?key=<sha256 BOT_TOKEN>
 * Дёргает API Lava.top серверной стороной ключом LAVA_WEBHOOK_SECRET (он
 * «sensitive» в Vercel — локально не читается, но сервер его видит), чтобы
 * выяснить рабочие эндпоинты и формат ответа для «деньги в пути» (в проверке).
 * Удалить после того, как форма API выяснена и сделан настоящий синк Lava.
 */

import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { childLogger } from '../../utils/logger.js';
import type { ApiHandler, ApiResponse } from '../http.js';

const log = childLogger({ handler: 'lava:probe' });

const CANDIDATES: Array<{ method: string; url: string }> = [
  { method: 'GET', url: 'https://gate.lava.top/api/v1/sales?page=0&size=5' },
  { method: 'GET', url: 'https://gate.lava.top/api/v2/sales?page=0&size=5' },
  { method: 'GET', url: 'https://gate.lava.top/api/v1/sales' },
  { method: 'GET', url: 'https://gate.lava.top/api/v2/products?page=0&size=5' },
  { method: 'GET', url: 'https://gate.lava.top/api/v1/invoices?page=0&size=5' },
  { method: 'GET', url: 'https://gate.lava.top/api/v1/balance' },
  { method: 'GET', url: 'https://gate.lava.top/api/v1/feed' },
];

export const lavaProbeHandler: ApiHandler = async (req): Promise<ApiResponse> => {
  const syncKey = createHash('sha256').update(config.BOT_TOKEN).digest('hex');
  if (req.query['key'] !== syncKey) {
    return { status: 401, body: { error: { code: 'unauthorized', message: 'bad key' } } };
  }

  const key = config.LAVA_WEBHOOK_SECRET;
  if (!key) return { status: 200, body: { ok: false, error: 'LAVA_WEBHOOK_SECRET не задан' } };

  const results: Array<Record<string, unknown>> = [];
  for (const c of CANDIDATES) {
    // Пробуем оба распространённых способа авторизации Lava.
    for (const authMode of ['X-Api-Key', 'Authorization'] as const) {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (authMode === 'X-Api-Key') headers['X-Api-Key'] = key;
      else headers['Authorization'] = key;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        const res = await fetch(c.url, { method: c.method, headers, signal: controller.signal });
        clearTimeout(timer);
        const text = await res.text();
        results.push({ url: c.url, auth: authMode, status: res.status, snippet: text.slice(0, 280) });
        if (res.ok) break; // нашли рабочую авторизацию для этого пути
      } catch (err) {
        results.push({ url: c.url, auth: authMode, error: String(err).slice(0, 120) });
      }
    }
  }

  log.info({ handler: 'lava_probe', tried: results.length }, 'lava_probe_done');
  return { status: 200, body: { ok: true, results } };
};
