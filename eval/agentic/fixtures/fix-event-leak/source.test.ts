import { describe, it, expect } from 'vitest';
import { EventEmitter, subscribe } from './source';

describe('subscribe / unsubscribe', () => {
  it('handler receives emitted events', () => {
    const emitter = new EventEmitter();
    const calls: unknown[] = [];
    subscribe(emitter, 'data', (v) => calls.push(v));
    emitter.emit('data', 42);
    expect(calls).toEqual([42]);
  });

  it('unsubscribe removes the listener so it stops firing', () => {
    const emitter = new EventEmitter();
    const calls: unknown[] = [];
    const unsub = subscribe(emitter, 'data', (v) => calls.push(v));
    emitter.emit('data', 1);
    unsub();
    emitter.emit('data', 2);
    expect(calls).toEqual([1]);
  });

  it('listener count drops to 0 after unsubscribe', () => {
    const emitter = new EventEmitter();
    const unsub = subscribe(emitter, 'ping', () => {});
    expect(emitter.listenerCount('ping')).toBe(1);
    unsub();
    expect(emitter.listenerCount('ping')).toBe(0);
  });

  it('multiple subscribes and unsubscribes work independently', () => {
    const emitter = new EventEmitter();
    const log: string[] = [];
    const unsub1 = subscribe(emitter, 'msg', () => log.push('a'));
    const unsub2 = subscribe(emitter, 'msg', () => log.push('b'));

    emitter.emit('msg');
    expect(log).toEqual(['a', 'b']);

    unsub1();
    emitter.emit('msg');
    expect(log).toEqual(['a', 'b', 'b']);
    expect(emitter.listenerCount('msg')).toBe(1);
  });
});
