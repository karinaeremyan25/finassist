/**
 * Раздача статических файлов собранного Mini App (Вариант B — self-contained Node).
 *
 * Логика:
 * - Обрабатывает только GET-запросы, не начинающиеся с /api.
 * - Резолвит путь к файлу относительно WEBAPP_STATIC_DIR.
 * - Защита от path traversal: нормализованный путь должен начинаться с rootResolved.
 * - SPA-fallback: если файл не найден И запрос не выглядит как файл с расширением → index.html.
 * - Cache-Control: no-cache для index.html, immutable для хешированных ассетов в /assets/.
 * - Если dist не собран (index.html отсутствует) → 404 JSON {error:{code:"webapp_not_built"}}.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

// ── MIME-типы по расширению ────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

// ── Cache-Control ──────────────────────────────────────────────────────────

/**
 * index.html — no-cache (браузер всегда делает условный запрос).
 * Хешированные ассеты в /assets/ — immutable (Vite добавляет хеш в имя файла).
 * Всё остальное — no-cache (безопасное умолчание).
 */
function getCacheControl(urlPath: string): string {
  if (urlPath === '/' || urlPath.endsWith('/index.html')) {
    return 'no-cache';
  }
  // /assets/... содержит хешированные имена файлов — можно кешировать надолго
  if (urlPath.startsWith('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

// ── Проверка: запрос похож на файл с расширением? ─────────────────────────

/**
 * Если URL-путь содержит расширение — считаем его конкретным файлом.
 * Иначе — SPA-маршрут (React Router / Hash Router) → fallback на index.html.
 */
function looksLikeFile(urlPath: string): boolean {
  const basename = path.basename(urlPath);
  return basename.includes('.') && !basename.startsWith('.');
}

// ── Основной static-хендлер ────────────────────────────────────────────────

/**
 * Попытка отдать статический файл.
 * Возвращает true, если запрос был обработан (ответ записан в res).
 * Возвращает false, если запрос не относится к статике (/api или не GET).
 */
export async function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  urlPath: string,
  staticDir: string
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // Только GET; /api — отдать обратно роутеру
  if (method !== 'GET') return false;
  if (urlPath.startsWith('/api')) return false;

  // Абсолютный путь к директории статики
  const rootResolved = path.resolve(staticDir);

  // Декодируем процент-кодирование. Malformed-последовательности (одиночный %)
  // → 400, чтобы не пробрасывать исключение в общий обработчик как 500.
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'bad_request', message: 'Bad path' } }));
    return true;
  }

  // ── PATH TRAVERSAL PROTECTION (defense-in-depth, до касания ФС) ──────────
  // Отвергаем null-byte и любой сегмент '..' ПОСЛЕ декодирования
  // (ловит %2e%2e%2f, обратные слэши и т.п.). Финальная проверка containment
  // ниже — основной backstop, эта — ранний отказ.
  const normalizedSlashes = decodedPath.replace(/\\/g, '/');
  if (
    decodedPath.includes('\0') ||
    normalizedSlashes.split('/').some((seg) => seg === '..')
  ) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'forbidden', message: 'Forbidden' } }));
    return true;
  }

  // Обрабатываем корневой путь и пути без расширения как index.html запрос
  const fileSuffix = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\//, '');

  // Строим кандидат файла
  const candidateRaw = path.join(rootResolved, fileSuffix);
  // Нормализуем (resolve убирает ../ и ./), защита от path traversal
  const candidateResolved = path.resolve(candidateRaw);

  // ── PATH TRAVERSAL PROTECTION ──────────────────────────────────────────
  // Нормализованный путь должен начинаться с rootResolved + sep
  // Это гарантирует, что мы остаёмся внутри staticDir.
  const rootWithSep = rootResolved.endsWith(path.sep)
    ? rootResolved
    : rootResolved + path.sep;

  if (
    candidateResolved !== rootResolved &&
    !candidateResolved.startsWith(rootWithSep)
  ) {
    // Попытка path traversal — отвечаем 403
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'forbidden', message: 'Forbidden' } }));
    return true;
  }

  // ── Попытка отдать запрошенный файл ───────────────────────────────────
  const served = await tryServeFile(candidateResolved, urlPath, res);
  if (served) return true;

  // ── SPA-fallback: если запрос не похож на конкретный файл → index.html ─
  if (!looksLikeFile(urlPath)) {
    const indexPath = path.join(rootResolved, 'index.html');
    const indexServed = await tryServeFile(indexPath, '/', res);
    if (indexServed) return true;

    // index.html отсутствует — фронт не собран
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'webapp_not_built',
          message: 'Mini App не собран. Выполните npm run build в src/app/webapp.',
        },
      })
    );
    return true;
  }

  // Файл с расширением не найден — 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'not_found', message: 'Файл не найден' } }));
  return true;
}

/**
 * Читает файл и отправляет его в res.
 * Возвращает true если файл найден и отправлен, false если файл не существует.
 */
async function tryServeFile(
  filePath: string,
  urlPath: string,
  res: http.ServerResponse
): Promise<boolean> {
  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch (err) {
    // ENOENT — файл не найден, всё остальное — пробрасываем
    if (isNodeError(err) && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }

  const mimeType = getMimeType(filePath);
  const cacheControl = getCacheControl(urlPath);

  res.writeHead(200, {
    'Content-Type': mimeType,
    'Cache-Control': cacheControl,
    'Content-Length': data.length,
  });
  res.end(data);
  return true;
}

// ── Утилита ────────────────────────────────────────────────────────────────

interface NodeError extends Error {
  code: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && 'code' in err;
}
