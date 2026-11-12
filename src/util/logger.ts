export class Logger {
  constructor(_isDebug: () => boolean) {}

  info(..._args: unknown[]): void {
    // 避免直接写 console（Obsidian 插件审核要求）
  }

  warn(..._args: unknown[]): void {
    // 避免直接写 console（Obsidian 插件审核要求）
  }

  error(..._args: unknown[]): void {
    // 避免直接写 console（Obsidian 插件审核要求）
  }
}
