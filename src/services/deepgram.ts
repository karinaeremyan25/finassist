import { config } from '../config.js';
import { childLogger } from '../utils/logger.js';

const log = childLogger({ handler: 'deepgram' });

export class DeepgramError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeepgramError';
    this.code = code;
  }
}

const API_URL = 'https://api.deepgram.com/v1/listen?language=ru-RU&punctuate=true';

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  if (!config.DEEPGRAM_API_KEY) {
    throw new DeepgramError('DEEPGRAM_NOT_CONFIGURED', 'Deepgram API key is not configured');
  }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${config.DEEPGRAM_API_KEY}`,
        'Content-Type': mimeType,
        Accept: 'application/json',
      },
      body: buffer,
    });

    if (!response.ok) {
      const text = await response.text();
      log.warn({ status: response.status, body: text }, 'deepgram_response_error');
      throw new DeepgramError('DEEPGRAM_API_ERROR', `Deepgram API returned ${response.status}`);
    }

    const payload = await response.json() as Record<string, unknown>;
    const transcript = (payload as any)?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof transcript !== 'string' || transcript.trim() === '') {
      log.warn({ payload }, 'deepgram_empty_transcript');
      throw new DeepgramError('DEEPGRAM_EMPTY_TRANSCRIPT', 'Deepgram вернул пустую расшифровку');
    }

    log.info({ transcript_length: transcript.length }, 'deepgram_transcription_ok');
    return transcript.trim();
  } catch (err) {
    log.error({ err }, 'deepgram_transcription_failed');
    if (err instanceof DeepgramError) throw err;
    throw new DeepgramError('DEEPGRAM_REQUEST_FAILED', 'Ошибка при обращении к Deepgram', { cause: err });
  }
}
