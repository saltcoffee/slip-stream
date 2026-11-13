export function installObsidianDom(): void {
  function create(tag: string, options: any = {}): HTMLElement {
    if (typeof options === "string") options = { cls: options };
    const el = document.createElement(tag);
    if (options.cls) el.className = options.cls;
    if (options.text != null) el.textContent = String(options.text);
    if (options.type) el.setAttribute("type", options.type);
    for (const [key, value] of Object.entries(options.attr ?? {})) {
      el.setAttribute(key, String(value));
    }
    return el;
  }

  Object.assign(HTMLElement.prototype, {
    createEl(this: HTMLElement, tag: string, options: unknown) {
      return this.appendChild(create(tag, options));
    },
    createDiv(this: HTMLElement, options: unknown) {
      return this.appendChild(create("div", options));
    },
    createSpan(this: HTMLElement, options: unknown) {
      return this.appendChild(create("span", options));
    },
    empty(this: HTMLElement) { this.replaceChildren(); },
    addClass(this: HTMLElement, name: string) { this.classList.add(name); },
    hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
    toggleClass(this: HTMLElement, name: string, force: boolean) { this.classList.toggle(name, force); },
    setText(this: HTMLElement, text: string) { this.textContent = text; },
    setCssProps(this: HTMLElement, props: Record<string, string>) {
      for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value);
    },
  });
  Object.assign(globalThis, { createDiv: (options: unknown) => create("div", options) });
}
