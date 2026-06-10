import { childLogger } from '../utils/logger.js';

const log = childLogger({ handler: 'vectorMemory' });

interface MemoryEntry {
  id: string;
  text: string;
  createdAt: number;
}

const memoryStore = new Map<bigint, MemoryEntry[]>();
const MAX_ENTRIES_PER_USER = 40;

function normalizeText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export async function saveMemory(telegramId: bigint, text: string): Promise<void> {
  const normalized = normalizeText(text);
  if (!normalized) return;

  const entries = memoryStore.get(telegramId) ?? [];
  entries.unshift({ id: crypto.randomUUID(), text: normalized, createdAt: Date.now() });
  if (entries.length > MAX_ENTRIES_PER_USER) entries.length = MAX_ENTRIES_PER_USER;
  memoryStore.set(telegramId, entries);

  log.info({ telegram_id: telegramId.toString(), stored: true, total: entries.length }, 'vector_memory_saved');
}

export async function getRelevantMemory(
  telegramId: bigint,
  query: string,
  limit = 3
): Promise<string[]> {
  const entries = memoryStore.get(telegramId) ?? [];
  if (entries.length === 0) return [];

  const queryWords = new Set(normalizeText(query).split(/\W+/).filter(Boolean));
  if (queryWords.size === 0) {
    return entries.slice(0, limit).map((entry) => entry.text);
  }

  const scored = entries
    .map((entry) => {
      const matched = entry.text
        .split(/\W+/)
        .filter(Boolean)
        .reduce((count, token) => (queryWords.has(token) ? count + 1 : count), 0);
      return { entry, score: matched };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)
    .slice(0, limit);

  if (scored.length > 0) {
    return scored.map((item) => item.entry.text);
  }

  return entries.slice(0, limit).map((entry) => entry.text);
}
