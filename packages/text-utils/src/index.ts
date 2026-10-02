const WIDE_SCRIPT_PATTERN =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\p{Script=Yi}⺀-〾㈀-㏿︰-﹯！-｠￠-￦]/u;

const EMOJI_PATTERN =
  /^(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F|[#*0-9]\uFE0F?\u20E3)/u;

let graphemeSegmenter: Intl.Segmenter | null = null;

function graphemes(text: string): Intl.Segments {
  graphemeSegmenter ??= new Intl.Segmenter("en", { granularity: "grapheme" });
  return graphemeSegmenter.segment(text);
}

function graphemeWidth(grapheme: string): number {
  if (grapheme.length === 0) return 0;
  if (EMOJI_PATTERN.test(grapheme)) return 2;
  return WIDE_SCRIPT_PATTERN.test(grapheme) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const segment of graphemes(text)) {
    width += graphemeWidth(segment.segment);
  }
  return width;
}

export function truncateToWidth(text: string, maxWidth: number): string {
  let width = 0;
  let end = 0;
  for (const segment of graphemes(text)) {
    const next = width + graphemeWidth(segment.segment);
    if (next > maxWidth) break;
    width = next;
    end = segment.index + segment.segment.length;
  }
  return text.slice(0, end);
}

function isSurrogate(code: number, first: number): boolean {
  return code >= first && code <= first + 0x3ff;
}

export function sliceUtf16Head(value: string, maxChars: number): string {
  const end = Math.min(value.length, Math.max(0, maxChars));
  const splitsPair =
    isSurrogate(value.charCodeAt(end - 1), 0xd800) &&
    isSurrogate(value.charCodeAt(end), 0xdc00);
  return value.slice(0, splitsPair ? end - 1 : end);
}
