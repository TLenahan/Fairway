import { requireNativeModule } from 'expo';
import { Platform } from 'react-native';

interface PracticeKeepAliveModule {
  start(title: string, body: string): void;
  stop(): void;
}

const native: PracticeKeepAliveModule | null =
  Platform.OS === 'android'
    ? requireNativeModule<PracticeKeepAliveModule>('PracticeKeepAlive')
    : null;

/** Start the connectedDevice foreground service (Android; no-op elsewhere). */
export function startKeepAlive(title: string, body: string): void {
  native?.start(title, body);
}

/** Stop the service and release the wake/Wi-Fi locks. */
export function stopKeepAlive(): void {
  native?.stop();
}
