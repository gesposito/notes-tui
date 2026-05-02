// Decoder for the handful of named HTML entities Apple Notes actually emits.
const NAMED_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

const decodeEntities = (s: string): string => {
  let out = s;
  for (const [k, v] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(k).join(v);
  }
  out = out.replace(/&#(\d+);/g, (_, code) =>
    String.fromCodePoint(Number.parseInt(code, 10)),
  );
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
    String.fromCodePoint(Number.parseInt(code, 16)),
  );
  return out;
};

/**
 * Convert an Apple Notes HTML body to terminal-friendly text.
 *
 * Tries to preserve:
 *  - Checklists (Apple uses a few HTML shapes — we match the common ones):
 *      `<input type="checkbox" checked>`         → `[x] `
 *      `<li class="checked">`                    → `[x] `
 *      `<ul class="checked"><li>...`             → `[x] ` (best effort)
 *  - Bulleted/numbered lists → `• `
 *  - Headers + paragraphs    → blank line separators
 *  - <br>                    → newline
 *
 * Drops everything else (attributes, attachments, formatting). For a richer
 * view the user can open the note in Notes.app proper.
 */
export const htmlToTerminalText = (html: string): string => {
  let text = html;

  // Checkbox <input> elements.
  text = text.replace(
    /<input\s+[^>]*type=["']checkbox["'][^>]*\bchecked\b[^>]*>/gi,
    "[x] ",
  );
  text = text.replace(
    /<input\s+[^>]*type=["']checkbox["'][^>]*>/gi,
    "[ ] ",
  );

  // Apple Notes checklist <li> variants. Class names vary across versions,
  // hence the broad match.
  text = text.replace(
    /<li[^>]*\bclass=["'][^"']*\b(?:checked|completed|done)\b[^"']*["'][^>]*>/gi,
    "[x] ",
  );
  text = text.replace(
    /<li[^>]*\bclass=["'][^"']*\b(?:unchecked|todo|cl)\b[^"']*["'][^>]*>/gi,
    "[ ] ",
  );

  // Headers → single newline both sides. Trailing \s* consumes the literal
  // newline between adjacent tags so the heading sits flush with body.
  text = text.replace(/<h[1-6][^>]*>\s*/gi, "\n");
  text = text.replace(/<\/h[1-6]>\s*/gi, "\n");

  // <br>, <p>, <div>. The trailing \s* consumes literal whitespace between
  // adjacent block tags (Apple's body HTML has a real newline between
  // every <div>, which would otherwise compound with our replacement
  // into a blank line between every visible row).
  // <div> = a row in Apple Notes, so a single \n suffices. <p> gets the
  // traditional blank-line paragraph break.
  text = text.replace(/<br\s*\/?>\s*/gi, "\n");
  text = text.replace(/<\/p\s*>\s*/gi, "\n\n");
  text = text.replace(/<\/div\s*>\s*/gi, "\n");
  text = text.replace(/<p[^>]*>/gi, "");
  text = text.replace(/<div[^>]*>/gi, "");

  // Remaining <li> rows that weren't checkbox-matched → bullet
  text = text.replace(/<li[^>]*>/gi, "• ");
  text = text.replace(/<\/li>/gi, "\n");

  // Drop everything else (anchors, spans, formatting, attachments).
  text = text.replace(/<[^>]+>/g, "");

  text = decodeEntities(text);

  // Collapse runs of >2 blank lines and trim.
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
};
