import { ANTHROPIC_URL, ANTHROPIC_VERSION } from './anthropic-client';
import { DEFAULT_MODEL } from './models';

/**
 * Lightweight key check for the Settings screen: a minimal 1-token messages
 * call. Only a 401 means the key is bad — any other status (200, 400, 429,
 * 5xx) proves the key was ACCEPTED even if the request itself is throttled or
 * rejected, which is all validation needs to know.
 */
export async function validateApiKey(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetchImpl(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  return response.status !== 401;
}
