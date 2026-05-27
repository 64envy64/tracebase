/**
 * Clock primitive (testable). Real production replaces this with Date.now.
 */
export class Clock {
  constructor(private nowFn: () => number = Date.now) {}
  now(): number { return this.nowFn(); }
}
