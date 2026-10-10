/**
 * Latin folding, shared by the search index and everything that finds a query
 * in a page's text afterwards: the search dialog's highlights and excerpts,
 * and the assistant's excerpts. The index matches Prüfung for `prufung`, so
 * the rest must too, or a page found by folding shows its opening with
 * nothing marked.
 */

/** A Latin letter and the combining marks on it, which NFD splits off. */
const LATIN_ACCENTS = /(?<letter>\p{Script=Latin})\p{M}+/gu;

/** A Latin character outside ASCII, once NFD has split off its accents. */
const NON_ASCII_LATIN = /(?=\P{ASCII})\p{Script=Latin}/gu;

/**
 * Latin letters NFD leaves whole, spelled the way an unaccented query types
 * them. Orama's own diacritics table folds the same letters, though its
 * English splitter cuts words at them first.
 */
const LATIN_FOLDS = new Map([
  ["ß", "ss"],
  ["æ", "ae"],
  ["œ", "oe"],
  ["ø", "o"],
  ["ł", "l"],
  ["đ", "d"],
  ["ð", "d"],
  ["ħ", "h"],
  ["ı", "i"],
  ["þ", "th"],
]);

/**
 * U+00AD, the invisible break hint `&shy;` writes inside a long word. It
 * belongs to no word: split there, Prüfungs&shy;ordnung would index as two.
 */
const SOFT_HYPHEN = /\u00AD/gu;

/** `text` without its soft hyphens. */
export const stripSoftHyphens = (text: string): string =>
  text.replace(SOFT_HYPHEN, "");

/**
 * Fold lowercased text's Latin letters to the plain letters an unaccented
 * query types: accents drop (café → cafe), letters NFD leaves whole are
 * spelled out (Łódź → lodz, ışık and IŞIK → isik, Straße → strasse), and
 * compatibility forms unpack (the ﬁ ligature → fi, fullwidth ＡＰＩ → api).
 * Soft hyphens go too. Marks on any other script, and marks on no letter
 * (the keycap in 1️⃣), stay.
 */
export const foldLatin = (lowered: string): string =>
  stripSoftHyphens(lowered)
    .normalize("NFD")
    .replace(
      NON_ASCII_LATIN,
      (letter) =>
        LATIN_FOLDS.get(letter) ?? letter.normalize("NFKD").toLowerCase()
    )
    .replace(LATIN_ACCENTS, "$<letter>");

/**
 * A run of Latin letters and the marks on them (lowercase İ is i plus a
 * combining dot), inside a term of any script.
 */
const LATIN_RUN = /\p{Script=Latin}[\p{Script=Latin}\p{M}]*/gu;

/**
 * {@link foldLatin} for the Latin letters of a lowercased term, whatever
 * script the rest of it is in: a segmenter keeps caféनमस्ते together as one
 * term. Only the Latin runs fold. Marks are spelling elsewhere (Thai vowels
 * and tones; the breve that separates Cyrillic й from и), and NFD would split
 * a Hangul syllable into its jamo.
 */
export const foldLatinTerm = (term: string): string =>
  term.replace(LATIN_RUN, (run) => foldLatin(run));

/**
 * The Unicode blocks holding Latin letters outside ASCII: Latin-1 through
 * Latin Extended-B, the phonetic extensions and Latin Extended Additional,
 * superscripts through number forms, Latin Extended-C, -D and -E, the
 * ligatures, and the fullwidth forms.
 */
const LATIN_BLOCKS = [
  [0x00_80, 0x02_4f],
  [0x1d_00, 0x1e_ff],
  [0x20_70, 0x21_8f],
  [0x2c_60, 0x2c_7f],
  [0xa7_20, 0xa7_ff],
  [0xab_30, 0xab_6f],
  [0xfb_00, 0xfb_06],
  [0xff_21, 0xff_5a],
] as const;

const LATIN = /^\p{Script=Latin}$/u;
const PLAIN = /^[a-z]+$/u;

let spellings: Map<string, string> | undefined;

/**
 * Every Latin character outside ASCII that folds to plain letters, keyed by
 * those letters: `a` → àáâ…, `ss` → ßẞ. Built on first use, not at import.
 */
const latinSpellings = (): Map<string, string> => {
  if (spellings) {
    return spellings;
  }
  spellings = new Map();
  for (const [first, last] of LATIN_BLOCKS) {
    for (let code = first; code <= last; code += 1) {
      const char = String.fromCodePoint(code);
      const plain = foldLatin(char.toLowerCase());
      if (LATIN.test(char) && PLAIN.test(plain)) {
        spellings.set(plain, `${spellings.get(plain) ?? ""}${char}`);
      }
    }
  }
  return spellings;
};

/** A Latin letter in a query, with the marks a decomposed query puts on it. */
const QUERY_LETTER = /\p{Script=Latin}\p{M}*/gu;

const REGEXP_SPECIAL = /[$()*+.?[\\\]^{|}]/gu;

/** What may follow a letter inside a word: its accents, or a soft hyphen. */
const LETTER_TAIL = String.raw`[\p{M}\u00AD]*`;

/**
 * The longest plain spelling a single character folds to (ⅷ → viii), so the
 * pattern builder knows how far ahead to look.
 */
const longestSpelling = (folds: Map<string, string>): number =>
  Math.max(...[...folds.keys()].map((plain) => plain.length));

/**
 * A regex source that finds `term` in unfolded text whatever accents, soft
 * hyphens or spelled-out letters its Latin words carry there: `prufung`
 * matches Prüfung, `strasse` matches Straße. Compile it with the `iu` flags.
 * Characters outside Latin match as themselves.
 */
export const accentInsensitive = (term: string): string => {
  const folds = latinSpellings();
  const longest = longestSpelling(folds);
  const letter = (plain: string): string =>
    `[${plain}${folds.get(plain) ?? ""}]${LETTER_TAIL}`;
  const chars = [
    ...stripSoftHyphens(term.toLowerCase()).replace(QUERY_LETTER, (latin) =>
      foldLatin(latin)
    ),
  ];
  let source = "";
  let index = 0;
  while (index < chars.length) {
    let length = Math.min(longest, chars.length - index);
    // The longest run here that a single character spells out — `ss` for ß.
    while (
      length > 1 &&
      !folds.has(chars.slice(index, index + length).join(""))
    ) {
      length -= 1;
    }
    const run = chars.slice(index, index + length);
    const plain = run.join("");
    if (length > 1) {
      const letters = run.map((char) => letter(char)).join("");
      source += `(?:${letters}|[${folds.get(plain) ?? ""}]${LETTER_TAIL})`;
    } else if (PLAIN.test(plain)) {
      source += letter(plain);
    } else {
      source += plain.replaceAll(REGEXP_SPECIAL, String.raw`\$&`);
    }
    index += length;
  }
  return source;
};
