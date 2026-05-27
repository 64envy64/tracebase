/**
 * Logger primitive. Tests construct with sink=array for capture.
 */
export class Logger {
  constructor(private sink: string[] = []) {}
  info(msg: string): void { this.sink.push(`info: ${msg}`); }
  warn(msg: string): void { this.sink.push(`warn: ${msg}`); }
  lines(): string[] { return [...this.sink]; }
}
