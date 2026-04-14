type Listener = (...args: unknown[]) => void;

/**
 * Simple event emitter.
 */
export class EventEmitter {
  private listeners: Map<string, Listener[]> = new Map();

  on(event: string, fn: Listener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(fn);
  }

  off(event: string, fn: Listener): void {
    const fns = this.listeners.get(event);
    if (!fns) return;
    this.listeners.set(
      event,
      fns.filter((f) => f !== fn)
    );
  }

  emit(event: string, ...args: unknown[]): void {
    const fns = this.listeners.get(event);
    if (!fns) return;
    fns.forEach((fn) => fn(...args));
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
}

/**
 * Subscribes a handler to an event and returns an unsubscribe function.
 */
export function subscribe(
  emitter: EventEmitter,
  event: string,
  handler: Listener
): () => void {
  emitter.on(event, (...args) => handler(...args));

  return () => {
    emitter.off(event, handler);
  };
}
