/**
 * Narrow transport seams so every protocol component is pure and
 * Node-testable. The react-native-tcp-socket / react-native-udp
 * implementations live in rn-transport.ts and are the ONLY files that touch
 * native modules.
 */
export interface TcpConnection {
  write(data: Uint8Array): void;
  onData(handler: (chunk: Uint8Array) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (err: Error) => void): void;
  destroy(): void;
}

export interface TcpConnectOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

export interface TcpFactory {
  /** Resolves once connected; rejects on refusal or timeout. */
  connect(opts: TcpConnectOptions): Promise<TcpConnection>;
}

export interface UdpSocket {
  onMessage(handler: (data: Uint8Array, fromIp: string) => void): void;
  close(): void;
}

export interface UdpFactory {
  /** Broadcast-enabled listener bound to `port`. */
  openBroadcastListener(port: number): Promise<UdpSocket>;
}

/** TCP connect timed out (vs. refused) — feeds the localNetworkDenied heuristic. */
export class ConnectTimeoutError extends Error {
  constructor(host: string, port: number) {
    super(`Connect to ${host}:${port} timed out`);
    this.name = 'ConnectTimeoutError';
  }
}
