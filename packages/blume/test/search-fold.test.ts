import { describe, expect, it } from "bun:test";

import {
  accentInsensitive,
  foldLatin,
  foldLatinTerm,
  stripSoftHyphens,
} from "../src/search/fold.ts";

const matches = (text: string, term: string): string[] =>
  text.match(new RegExp(accentInsensitive(term), "giu")) ?? [];

describe("foldLatin", () => {
  it("drops accents and spells out letters NFD leaves whole", () => {
    expect(foldLatin("prüfung łódź ışık işik straße encyclopædia")).toBe(
      "prufung lodz isik isik strasse encyclopaedia"
    );
  });

  it("unpacks compatibility forms to lowercase plain letters", () => {
    // The ﬁ ligature, fullwidth letters, an ordinal indicator, a Roman
    // numeral, and a modifier capital that lowercasing leaves uppercase.
    expect(foldLatin("conﬁguration ａｐｉ 1º ⅻ ᴬ")).toBe(
      "configuration api 1o xii a"
    );
  });

  it("drops soft hyphens and keeps marks on anything but a Latin letter", () => {
    expect(foldLatin("prüfungs\u00ADordnung")).toBe("prufungsordnung");
    expect(foldLatin("1\uFE0F\u20E3 й")).toBe("1\uFE0F\u20E3 и\u0306");
  });
});

describe("foldLatinTerm", () => {
  it("folds the Latin letters of a term, whatever script the rest is in", () => {
    expect(foldLatinTerm("i\u0307stanbul")).toBe("istanbul");
    expect(foldLatinTerm("йогурт")).toBe("йогурт");
    expect(foldLatinTerm("검색")).toBe("검색");
    expect(foldLatinTerm("caféनमस्ते")).toBe("cafeनमस्ते");
  });
});

describe("stripSoftHyphens", () => {
  it("removes every soft hyphen", () => {
    expect(stripSoftHyphens("a\u00ADb\u00ADc")).toBe("abc");
  });
});

describe("accentInsensitive", () => {
  it("matches accented and spelled-out letters in unfolded text", () => {
    expect(matches("Die Prüfung", "prufung")).toEqual(["Prüfung"]);
    expect(matches("Die Straße, die STRASSE", "strasse")).toEqual([
      "Straße",
      "STRASSE",
    ]);
    expect(matches("Łódź, IŞIK, ışık", "lodz")).toEqual(["Łódź"]);
    expect(matches("IŞIK, ışık", "isik")).toEqual(["IŞIK", "ışık"]);
  });

  it("folds an accented or decomposed query the same way", () => {
    expect(matches("Ein Café", "café")).toEqual(["Café"]);
    expect(matches("Ein Cafe\u0301", "cafe\u0301")).toEqual(["Cafe\u0301"]);
  });

  it("matches across soft hyphens and compatibility forms", () => {
    expect(matches("Prüfungs\u00ADordnung", "prufungsordnung")).toEqual([
      "Prüfungs\u00ADordnung",
    ]);
    expect(matches("conﬁguration", "configuration")).toEqual(["conﬁguration"]);
  });

  it("matches everything outside Latin as itself, regex syntax included", () => {
    expect(matches("C++ and c+", "c++")).toEqual(["C++"]);
    expect(matches("йогурт иогурт", "йогурт")).toEqual(["йогурт"]);
  });
});
