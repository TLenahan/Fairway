import {
  AnalysisRecord,
  AnalysisScope,
  AnalysisService,
  AnalysisVerdict,
  AnalysisVerdictSchema,
  BaselineSet,
  DataStore,
} from '@golf/types';
import { z } from 'zod';

import { AnthropicClient, AnthropicClientDeps } from './anthropic-client';
import { createBaselineSet } from './baselines';
import { AnalysisParseError } from './errors';
import {
  AnalysisInput,
  buildAnalysisPayload,
  payloadToUserMessage,
} from './payload';
import { chatSystemPrompt, systemPrompt, VERDICT_SENTINEL } from './prompts';

const ANALYZE_MAX_TOKENS = 4000;
const CHAT_MAX_TOKENS = 1500;

export interface AnalysisServiceDeps extends AnthropicClientDeps {
  baselines?: BaselineSet;
  /** When provided, every analyze() persists an AnalysisRecord. */
  dataStore?: DataStore;
  newId?(): string;
  now?(): number;
}

/**
 * Streams narrative text to onDelta while holding back anything that could be
 * the start of the sentinel, so the sentinel and JSON never leak into the UI.
 */
class SentinelGate {
  private held = '';
  private sentinelSeen = false;

  constructor(
    private readonly sentinel: string,
    private readonly onNarrative?: (chunk: string) => void,
  ) {}

  push(chunk: string): void {
    if (this.sentinelSeen) return;
    this.held += chunk;
    const idx = this.held.indexOf(this.sentinel);
    if (idx >= 0) {
      this.sentinelSeen = true;
      const narrative = this.held.slice(0, idx);
      if (narrative) this.onNarrative?.(narrative);
      this.held = '';
      return;
    }
    // emit all but a sentinel-length tail that might be a partial match
    const safe = this.held.length - this.sentinel.length;
    if (safe > 0) {
      this.onNarrative?.(this.held.slice(0, safe));
      this.held = this.held.slice(safe);
    }
  }

  flush(): void {
    if (!this.sentinelSeen && this.held) {
      this.onNarrative?.(this.held);
      this.held = '';
    }
  }
}

const stripFences = (text: string): string =>
  text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

const defaultNewId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && 'randomUUID' in cryptoApi) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export function createAnalysisService(
  deps: AnalysisServiceDeps,
): AnalysisService {
  const client = new AnthropicClient(deps);
  const baselines = deps.baselines ?? createBaselineSet();
  const newId = deps.newId ?? defaultNewId;
  const now = deps.now ?? Date.now;

  async function parseVerdict(
    rawTail: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<AnalysisVerdict> {
    const direct = AnalysisVerdictSchema.safeParse(
      tryJson(stripFences(rawTail)),
    );
    if (direct.success) return direct.data;

    // one repair attempt: ask for ONLY corrected JSON, non-streaming
    const repaired = await client.completeMessage({
      model,
      maxTokens: ANALYZE_MAX_TOKENS,
      system:
        'You fix malformed JSON. Return ONLY a valid JSON object matching the requested schema — no prose, no markdown fences.',
      messages: [
        {
          role: 'user',
          content: `This text was supposed to be a JSON object with keys headline (string), issues (array of {area, severity: low|medium|high, evidence, why}), strengths (array of {area, evidence}), drills (array of {name, goal, howMeasured}), caveats (array of strings). Return the corrected JSON only:\n\n${rawTail}`,
        },
      ],
      signal,
    });
    const retried = AnalysisVerdictSchema.safeParse(
      tryJson(stripFences(repaired)),
    );
    if (retried.success) return retried.data;
    throw new AnalysisParseError(
      'The model did not return a valid analysis verdict (after one repair attempt).',
    );
  }

  return {
    async analyze(scope, input: AnalysisInput, opts) {
      const payload = buildAnalysisPayload(scope, input, baselines);
      const gate = new SentinelGate(VERDICT_SENTINEL, opts.onDelta);

      const fullText = await client.streamMessage({
        model: opts.model,
        maxTokens: ANALYZE_MAX_TOKENS,
        system: systemPrompt(input.environment),
        messages: [{ role: 'user', content: payloadToUserMessage(payload) }],
        onDelta: (chunk) => gate.push(chunk),
        signal: opts.signal,
      });
      gate.flush();

      const sentinelIdx = fullText.indexOf(VERDICT_SENTINEL);
      const narrative = (
        sentinelIdx >= 0 ? fullText.slice(0, sentinelIdx) : fullText
      ).trim();
      const tail =
        sentinelIdx >= 0
          ? fullText.slice(sentinelIdx + VERDICT_SENTINEL.length)
          : fullText;
      const verdict = await parseVerdict(tail, opts.model, opts.signal);

      if (deps.dataStore) {
        const record: AnalysisRecord = {
          id: newId(),
          sessionId: input.current.sessionId,
          scope: scope as z.infer<typeof AnalysisScope>,
          model: opts.model,
          createdAt: now(),
          verdict,
          narrative,
          inputSummary: payload,
        };
        await deps.dataStore.saveAnalysis(record);
      }

      return { verdict, narrative };
    },

    async chat(context, history, message, opts) {
      return client.streamMessage({
        model: opts.model,
        maxTokens: CHAT_MAX_TOKENS,
        system: chatSystemPrompt(
          JSON.stringify(context.summary, null, 2),
          context.priorAnalysis
            ? JSON.stringify(context.priorAnalysis.verdict, null, 2)
            : null,
        ),
        messages: [...history, { role: 'user', content: message }],
        onDelta: opts.onDelta,
        signal: opts.signal,
      });
    },
  };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
