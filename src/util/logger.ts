export class Logger {
  constructor(private isDebug: () => boolean) {}

  info(...args: unknown[]): void {
    if (this.isDebug()) console.info("[SlipStream]", ...args);
  }

  warn(...args: unknown[]): void {
    console.warn("[SlipStream]", ...args);
  }

  error(...args: unknown[]): void {
    console.error("[SlipStream]", ...args);
  }
}
