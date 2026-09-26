import { OramaClient } from "@oramacloud/client";

import type { OramaCloudOptions } from "../../../search/adapters/orama-cloud.ts";
import {
  byBoost,
  excerptFor,
  highlight,
  RESULT_POOL,
  SEARCH_LIMIT,
} from "./types.ts";
import type { SearchFn } from "./types.ts";

interface OramaCloudRecord {
  url: string;
  title: string;
  description?: string;
  content?: string;
  boost?: number;
}

/**
 * Orama Cloud: the browser queries the hosted index directly with the public
 * endpoint + API key. Records are pushed at build time by the sync step. Every
 * adapter option Blume doesn't read is the site's own client option and goes
 * to `OramaClient` untouched; `indexId` belongs to the sync and stays out.
 */
export const createSearch = (opts: OramaCloudOptions): SearchFn => {
  const { apiKey, endpoint, indexId: _syncOnly, ...clientOptions } = opts;
  const client = new OramaClient({
    ...clientOptions,
    api_key: apiKey,
    endpoint,
  });
  return async (query, options) => {
    // A pool beyond the visible limit, so each page's `search.boost` can
    // lift a hit into view before the list is cut.
    const results = await client.search({
      limit: RESULT_POOL,
      term: query,
      // The sync carries `locale` on every record so an i18n site can scope
      // hosted results to the active language.
      ...(options?.locale && { where: { locale: options.locale } }),
    });
    const ranked = byBoost(
      (results?.hits ?? []).map((hit) => {
        const doc: OramaCloudRecord = hit.document;
        return { boost: doc.boost, match: doc, score: hit.score };
      })
    );
    const hits = ranked.slice(0, SEARCH_LIMIT).map((doc) => ({
      content: doc.content ?? "",
      excerpt: highlight(
        excerptFor(doc.description ?? "", doc.content ?? "", query),
        query
      ),
      title: highlight(doc.title, query),
      url: doc.url,
    }));
    return { hits, sections: [] };
  };
};
