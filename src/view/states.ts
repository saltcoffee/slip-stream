export function renderSkeleton(container: HTMLElement, count: number): void {
  container.empty();
  const n = Math.max(1, Math.min(count, 6));
  for (let i = 0; i < n; i++) {
    container.createDiv({ cls: "slipstream-skeleton" });
  }
}

export function renderEmpty(container: HTMLElement, message: string): void {
  container.empty();
  const state = container.createDiv({ cls: "slipstream-state" });
  state.createDiv({ text: message });
}

export function renderError(
  container: HTMLElement,
  message: string,
  onRetry: () => void,
  retryLabel: string
): void {
  container.empty();
  const state = container.createDiv({ cls: "slipstream-state" });
  state.createDiv({ text: message });
  const btn = state.createEl("button", { cls: "slipstream-btn", text: retryLabel });
  btn.addEventListener("click", onRetry);
}
