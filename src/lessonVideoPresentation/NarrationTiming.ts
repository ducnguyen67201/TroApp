/** Fixed-size pages keep narration readable without geometry measurement or model repair. */
export function splitNarration(text: string, maxCharacters = 180): string[] {
  const pages: string[] = [];
  let remaining = text.trim();
  while (remaining.length) {
    let end = Math.min(maxCharacters, remaining.length);
    if (end < remaining.length) {
      const space = remaining.lastIndexOf(' ', end);
      if (space > end / 2) {
        end = space;
      }
    }
    pages.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trim();
  }
  return pages;
}
