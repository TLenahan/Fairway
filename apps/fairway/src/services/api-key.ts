import * as SecureStore from 'expo-secure-store';

/**
 * The Anthropic API key lives ONLY in expo-secure-store (BUILD_SPEC rule #7):
 * never in SQLite, logs, exports, or the settings store.
 */
const KEY = 'fairway.anthropic_api_key';

export async function getApiKey(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY);
}

export async function setApiKey(value: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, value.trim());
}

export async function clearApiKey(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
