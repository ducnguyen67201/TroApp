const VietnameseLetters = new Set([
  0x0102, 0x0103, 0x0110, 0x0111, 0x0128, 0x0129, 0x0168, 0x0169, 0x01a0, 0x01a1, 0x01af, 0x01b0,
]);
const LessonPunctuation = new Set([
  0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2018, 0x2019, 0x201a, 0x201b, 0x201c, 0x201d,
  0x201e, 0x201f, 0x2022, 0x2026, 0x2032, 0x2033, 0x20ac, 0x2122,
]);
const VietnameseCombiningMarks = new Set([
  0x0300, 0x0301, 0x0302, 0x0303, 0x0306, 0x0309, 0x031b, 0x0323,
]);

/** The beta qualifies English/Vietnamese lesson text, rather than relying on machine-dependent font fallback. */
export function usesLessonGlyphs(text: string): boolean {
  return Array.from(text.normalize('NFC')).every((character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      return false;
    }
    return (
      codePoint === 0x0a ||
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0xa0 && codePoint <= 0xff && codePoint !== 0xad) ||
      VietnameseLetters.has(codePoint) ||
      (codePoint >= 0x1ea0 && codePoint <= 0x1ef9) ||
      VietnameseCombiningMarks.has(codePoint) ||
      LessonPunctuation.has(codePoint)
    );
  });
}
