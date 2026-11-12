import { Menu } from "obsidian";
import type { Density, SortKey } from "../domain/types";
import { debounce } from "../util/debounce";
import { t } from "../util/i18n";

export interface ToolbarHost {
  getDensity(): Density;
  setDensity(d: Density): void;
  getSort(): SortKey;
  getSortAsc(): boolean;
  setSort(key: SortKey): void;
  setSortAsc(asc: boolean): void;
  getFilter(): string;
  setFilter(value: string): void;
  refresh(): void;
  toggleShowHidden(): void;
  isShowHidden(): boolean;
  collapseAll(): void;
  expandAll(): void;
  clearCache(): void;
}

const DENSITIES: Density[] = ["full", "snippet", "compact"];
const SORTS: SortKey[] = ["mtime", "ctime", "name", "custom"];

export class Toolbar {
  readonly el: HTMLElement;
  private densityButtons = new Map<Density, HTMLElement>();

  constructor(private host: ToolbarHost) {
    this.el = createDiv({ cls: "slipstream-toolbar" });

    for (const d of DENSITIES) {
      const btn = this.el.createEl("button", { cls: "slipstream-btn", text: t(`tb.${d}`) });
      btn.addEventListener("click", () => {
        this.host.setDensity(d);
        this.syncDensity();
      });
      this.densityButtons.set(d, btn);
    }

    const filter = this.el.createEl("input", {
      type: "text",
      attr: { placeholder: t("tb.filter") },
    });
    filter.value = this.host.getFilter();
    const onFilter = debounce((value: string) => this.host.setFilter(value), 120);
    filter.addEventListener("input", () => onFilter(filter.value));

    const sort = this.el.createEl("select");
    for (const s of SORTS) {
      sort.createEl("option", { text: t(`sort.${s}`), attr: { value: s } });
    }
    sort.value = this.host.getSort();
    sort.addEventListener("change", () => this.host.setSort(sort.value as SortKey));

    const orderBtn = this.el.createEl("button", {
      cls: "slipstream-btn",
      text: this.host.getSortAsc() ? "↑" : "↓",
      attr: { "aria-label": this.host.getSortAsc() ? t("sort.asc") : t("sort.desc") },
    });
    orderBtn.addEventListener("click", () => {
      const next = !this.host.getSortAsc();
      this.host.setSortAsc(next);
      orderBtn.setText(next ? "↑" : "↓");
    });

    const more = this.el.createEl("button", { cls: "slipstream-btn", text: t("tb.more") });
    more.addEventListener("click", (e) => this.openMore(e));

    this.syncDensity();
  }

  private openMore(evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle(t("tb.refresh")).setIcon("refresh-cw").onClick(() => this.host.refresh())
    );
    menu.addItem((i) =>
      i
        .setTitle(t("tb.showHidden"))
        .setIcon(this.host.isShowHidden() ? "check" : "eye-off")
        .onClick(() => this.host.toggleShowHidden())
    );
    menu.addItem((i) =>
      i.setTitle(t("tb.collapseAll")).setIcon("chevrons-down-up").onClick(() => this.host.collapseAll())
    );
    menu.addItem((i) =>
      i.setTitle(t("tb.expandAll")).setIcon("chevrons-up-down").onClick(() => this.host.expandAll())
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle(t("tb.clearCache")).setIcon("trash").onClick(() => this.host.clearCache())
    );
    menu.showAtMouseEvent(evt);
  }

  private syncDensity(): void {
    const current = this.host.getDensity();
    for (const [d, btn] of this.densityButtons) {
      btn.toggleClass("is-active", d === current);
    }
  }
}
