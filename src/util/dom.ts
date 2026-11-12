export function empty(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function setText(el: HTMLElement, text: string): void {
  el.setText(text);
}
