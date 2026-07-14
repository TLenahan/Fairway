import {
  apiErrorForStatus,
  apiErrorForType,
  AnalysisServerError,
  MissingKeyError,
} from './errors';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicClientDeps {
  /** Key comes from expo-secure-store in the app; injected so the lib stays pure. */
  getApiKey(): Promise<string | null>;
  /**
   * Defaults to globalThis.fetch. The app must pass `fetch` from 'expo/fetch'
   * — React Native's built-in fetch cannot stream response bodies.
   */
  fetchImpl?: typeof fetch;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MessageRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: ChatMessage[];
  onDelta?: (textChunk: string) => void;
  signal?: AbortSignal;
}

interface SseEvent {
  event: string;
  data: string;
}

/** Incremental `event:`/`data:` line parser for an SSE byte stream. */
class SseParser {
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];

  push(chunk: string, onEvent: (e: SseEvent) => void): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line === '') {
        if (this.dataLines.length > 0) {
          onEvent({ event: this.eventName, data: this.dataLines.join('\n') });
        }
        this.eventName = '';
        this.dataLines = [];
      } else if (line.startsWith('event:')) {
        this.eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        this.dataLines.push(line.slice('data:'.length).trim());
      }
    }
  }
}

interface DeltaPayload {
  type?: string;
  delta?: { type?: string; text?: string };
  error?: { type?: string; message?: string };
}

/**
 * Minimal Anthropic Messages client (BUILD_SPEC Appendix B): direct HTTPS,
 * SSE streaming, typed error mapping. No SDK — the payloads here are small
 * and the streaming path must run on React Native via expo/fetch.
 */
export class AnthropicClient {
  private readonly getApiKey: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: AnthropicClientDeps) {
    this.getApiKey = deps.getApiKey;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Stream a message; onDelta receives text chunks; resolves to the full text. */
  async streamMessage(request: MessageRequest): Promise<string> {
    const response = await this.post(request, true);
    const body = response.body;
    if (!body) {
      throw new AnalysisServerError(
        'Streaming response had no body — pass fetch from expo/fetch on React Native.',
        500,
      );
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let fullText = '';
    let streamError: Error | null = null;

    const handleEvent = (e: SseEvent) => {
      if (e.data === '[DONE]') return;
      let payload: DeltaPayload;
      try {
        payload = JSON.parse(e.data) as DeltaPayload;
      } catch {
        return;
      }
      if (payload.type === 'error' || e.event === 'error') {
        streamError = apiErrorForType(
          payload.error?.type ?? 'api_error',
          payload.error?.message ?? 'Anthropic stream error',
        );
        return;
      }
      if (
        payload.type === 'content_block_delta' &&
        payload.delta?.type === 'text_delta' &&
        typeof payload.delta.text === 'string'
      ) {
        fullText += payload.delta.text;
        request.onDelta?.(payload.delta.text);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }), handleEvent);
      if (streamError) {
        await reader.cancel().catch(() => undefined);
        throw streamError;
      }
    }
    if (streamError) throw streamError;
    return fullText;
  }

  /** One-shot (non-streaming) message; resolves to the concatenated text. */
  async completeMessage(
    request: Omit<MessageRequest, 'onDelta'>,
  ): Promise<string> {
    const response = await this.post(request, false);
    const json = (await response.json()) as {
      content?: { type: string; text?: string }[];
    };
    return (json.content ?? [])
      .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
      .join('');
  }

  private async post(
    request: Omit<MessageRequest, 'onDelta'>,
    stream: boolean,
  ): Promise<Response> {
    const key = await this.getApiKey();
    if (!key) throw new MissingKeyError();

    const response = await this.fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: request.messages,
        stream,
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      const detail = await extractErrorMessage(response);
      throw apiErrorForStatus(response.status, detail);
    }
    return response;
  }
}

async function extractErrorMessage(
  response: Response,
): Promise<string | undefined> {
  try {
    const json = (await response.json()) as {
      error?: { message?: string };
    };
    return json.error?.message;
  } catch {
    return undefined;
  }
}
