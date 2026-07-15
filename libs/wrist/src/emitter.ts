/**
 * Minimal typed event emitter — deliberately not Node's 'events' so the lib
 * has zero Node-builtin runtime deps in React Native. (Same shape as
 * @golf/monitor's; module boundaries forbid importing it across libs.)
 */
export class TypedEmitter<
  Events extends Record<keyof Events, (...args: never[]) => void>,
> {
  private handlers = new Map<keyof Events, Set<Events[keyof Events]>>();

  on<K extends keyof Events>(event: K, handler: Events[K]): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off<K extends keyof Events>(event: K, handler: Events[K]): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (...a: Parameters<Events[K]>) => void)(...args);
    }
  }
}
