import type { UIStringsOverride } from "../i18n-ui.ts";
import { ar } from "./ar.ts";
import { bg } from "./bg.ts";
import { bn } from "./bn.ts";
import { ca } from "./ca.ts";
import { cs } from "./cs.ts";
import { da } from "./da.ts";
import { de } from "./de.ts";
import { el } from "./el.ts";
import { es } from "./es.ts";
import { fa } from "./fa.ts";
import { fi } from "./fi.ts";
import { fr } from "./fr.ts";
import { he } from "./he.ts";
import { hi } from "./hi.ts";
import { hr } from "./hr.ts";
import { hu } from "./hu.ts";
import { id } from "./id.ts";
import { it } from "./it.ts";
import { ja } from "./ja.ts";
import { ko } from "./ko.ts";
import { nl } from "./nl.ts";
import { no } from "./no.ts";
import { pl } from "./pl.ts";
import { ptBR } from "./pt-br.ts";
import { pt } from "./pt.ts";
import { ro } from "./ro.ts";
import { ru } from "./ru.ts";
import { sk } from "./sk.ts";
import { sr } from "./sr.ts";
import { sv } from "./sv.ts";
import { th } from "./th.ts";
import { tr } from "./tr.ts";
import { uk } from "./uk.ts";
import { vi } from "./vi.ts";
import { zhTW } from "./zh-tw.ts";
import { zh } from "./zh.ts";

/**
 * Built-in translation packs, one module per locale (`./<code>.ts`). English is
 * the schema baseline, so it has no pack; every other locale ships a starter
 * pack so adopters get translated chrome out of the box. Brand names (Cursor,
 * VS Code, MCP, Claude Code, Markdown, GitHub) are kept verbatim. Packs are
 * community-maintained — open a PR to add a locale or sharpen a translation.
 *
 * Keyed by locale code; regional variants use the BCP 47 form (`pt-BR`,
 * `zh-TW`). A locale's pack is merged onto English by {@link resolveUIStrings},
 * so a pack only needs the keys it translates.
 */
export const UI_PACKS: Record<string, UIStringsOverride> = {
  ar,
  bg,
  bn,
  ca,
  cs,
  da,
  de,
  el,
  es,
  fa,
  fi,
  fr,
  he,
  hi,
  hr,
  hu,
  id,
  it,
  ja,
  ko,
  nl,
  no,
  pl,
  pt,
  "pt-BR": ptBR,
  ro,
  ru,
  sk,
  sr,
  sv,
  th,
  tr,
  uk,
  vi,
  zh,
  "zh-TW": zhTW,
};
