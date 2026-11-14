import { ItemView, WorkspaceLeaf, ViewStateResult } from "obsidian";
import { VIEW_TYPE_SLIPSTREAM } from "../constants";
import type SlipStreamPlugin from "../main";
import { CardStreamController } from "../domain/CardStreamController";

export class SlipStreamView extends ItemView {
  private controller!: CardStreamController;
  private pendingState: unknown = undefined;

  constructor(leaf: WorkspaceLeaf, private plugin: SlipStreamPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_SLIPSTREAM;
  }

  getDisplayText(): string {
    return "SlipStream";
  }

  getIcon(): string {
    return "layers";
  }

  async onOpen(): Promise<void> {
    this.controller = new CardStreamController(this.plugin, this);
    await this.controller.restore(this.pendingState ?? this.getState());
    await this.controller.mount(this.contentEl);
  }

  async onClose(): Promise<void> {
    this.controller?.destroy();
  }

  getState(): Record<string, unknown> {
    return this.controller ? this.controller.serializeViewState() : {};
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.pendingState = state;
    if (this.controller) {
      await this.controller.restore(state);
      await this.controller.mount(this.contentEl);
    }
    await super.setState(state, result);
  }

  requestSaveState(): void {
    const ws = this.app.workspace as unknown as { requestSaveLayout?: () => void };
    ws.requestSaveLayout?.();
  }

  bindTarget(editorId: string): void { this.controller?.bindTarget(editorId); }
  refreshCitationContext(): void { this.controller?.refreshCitationContext(); }

  refreshFromExternal(): void {
    this.controller?.refreshSilent();
  }

  relocalize(): void {
    if (this.controller) void this.controller.mount(this.contentEl);
  }
}
