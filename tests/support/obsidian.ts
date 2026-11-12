/** Minimal Obsidian runtime stub for unit tests. */
export function getLanguage(): string {
  return "en";
}

export const moment = {
  locale: (): string => "en",
};
