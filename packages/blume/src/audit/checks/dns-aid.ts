import type { Diagnostic } from "../../core/types.ts";
import { finding } from "../catalog.ts";
import type { CheckModule } from "../types.ts";

/**
 * DNS-AID (draft-mozleywilliams-dnsop-dnsaid): agents discover a site's AI
 * surface by querying ServiceMode SVCB/HTTPS records under the `_agents` DNS
 * namespace — the well-known entrypoint is `_index._agents.<host>`. The
 * records live in the DNS zone, which no build artifact can publish, so this
 * check probes the live DNS over DoH and reports what to add. It queries the
 * `deployment.site` host (the domain agents actually probe), not the `--url`
 * origin, which is often a localhost preview.
 */

/** SVCB and its HTTPS specialization (RFC 9460). */
const RR_SVCB = 64;
const RR_HTTPS = 65;

const DOH_TIMEOUT_MS = 5000;

/**
 * DoH JSON resolvers, tried in order until one answers. Both accept the same
 * `?name=&type=` query and the `application/dns-json` accept header (Google
 * ignores it, Cloudflare requires it). `BLUME_DOH_URL` overrides the list for
 * networks that block the public resolvers (and for tests, which must never
 * touch the real DNS).
 */
const DOH_RESOLVERS = [
  "https://dns.google/resolve",
  "https://cloudflare-dns.com/dns-query",
];

const resolvers = (): string[] => {
  const override = process.env.BLUME_DOH_URL;
  return override ? [override] : DOH_RESOLVERS;
};

/** The subset of the DoH JSON response this check reads (RFC 8427-shaped). */
interface DohResponse {
  /** DNSSEC-validated by the resolver (the AD flag). */
  AD?: boolean;
  Answer?: { data?: string; type?: number }[];
  Status?: number;
}

export interface DnsAidResult {
  /** Whether every record set found came back DNSSEC-authenticated. */
  authenticated: boolean;
  /** Whether any SVCB/HTTPS record exists at the well-known entrypoint. */
  found: boolean;
}

/** One resolver's answer, or null when it's unreachable or not DoH-JSON. */
const fetchDohJson = async (
  base: string,
  name: string,
  type: number,
  fetchFn: typeof fetch
): Promise<DohResponse | null> => {
  try {
    const response = await fetchFn(
      `${base}?name=${encodeURIComponent(name)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      return null;
    }
    // SAFETY: the resolver answered a dns-json query, whose response schema
    // DohResponse models with every field optional; a malformed body that
    // fails to parse rejects into the catch below.
    return (await response.json()) as DohResponse;
  } catch {
    return null;
  }
};

const queryDoh = async (
  name: string,
  type: number,
  fetchFn: typeof fetch
): Promise<DohResponse | null> => {
  for (const base of resolvers()) {
    // oxlint-disable-next-line no-await-in-loop -- fallback chain: the next resolver is only tried when this one fails
    const response = await fetchDohJson(base, name, type, fetchFn);
    if (response) {
      return response;
    }
  }
  return null;
};

/**
 * Query the DNS-AID entrypoint for a host over DoH: both SVCB and HTTPS
 * rrtypes at `_index._agents.<host>` (the checker-facing convention accepts
 * either). Returns null when no resolver answered at all — "couldn't check"
 * must stay distinct from "checked and absent", or a flaky network would
 * report every site as undiscoverable.
 */
export const lookupDnsAid = async (
  host: string,
  fetchFn: typeof fetch = fetch
): Promise<DnsAidResult | null> => {
  const name = `_index._agents.${host}`;
  let answered = false;
  let found = false;
  let authenticated = true;
  const responses = await Promise.all(
    [RR_HTTPS, RR_SVCB].map((type) => queryDoh(name, type, fetchFn))
  );
  for (const response of responses) {
    if (!response) {
      continue;
    }
    answered = true;
    const records = (response.Answer ?? []).filter(
      (answer) => answer.type === RR_SVCB || answer.type === RR_HTTPS
    );
    if (records.length > 0) {
      found = true;
      authenticated &&= response.AD === true;
    }
  }
  return answered ? { authenticated, found } : null;
};

/** The findings for a lookup result — pure, so it's testable without DoH. */
export const dnsAidFindings = (
  host: string,
  result: DnsAidResult
): Diagnostic[] => {
  if (!result.found) {
    return [
      finding(
        "BLUME_AUDIT_DNS_AID_MISSING",
        { url: "/" },
        `No SVCB or HTTPS records at _index._agents.${host} — agents probing DNS for AI Discovery (DNS-AID) find nothing.`,
        `Publish a ServiceMode record with your DNS provider, e.g. \`_index._agents.${host}. 3600 IN HTTPS 1 ${host}. alpn=h2\`, and sign the zone with DNSSEC if the provider supports it.`
      ),
    ];
  }
  if (!result.authenticated) {
    return [
      finding(
        "BLUME_AUDIT_DNS_AID_UNSIGNED",
        { url: "/" },
        `The DNS-AID records at _index._agents.${host} exist but are not DNSSEC-authenticated, so validating resolvers can't prove they're genuine.`
      ),
    ];
  }
  return [];
};

/** The `deployment.site` hostname, or null when unset/unusable for DNS. */
export const dnsAidHost = (site?: string): string | null => {
  if (!site) {
    return null;
  }
  let hostname: string;
  try {
    ({ hostname } = new URL(site));
  } catch {
    return null;
  }
  // A local or dotless host has no public zone to query.
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    !hostname.includes(".")
  ) {
    return null;
  }
  return hostname;
};

export const dnsAidChecks: CheckModule = {
  category: "ai",
  async run(context) {
    if (!context.origin) {
      return [];
    }
    const host = dnsAidHost(context.project.config.deployment.site);
    if (!host) {
      return [];
    }
    const result = await lookupDnsAid(host);
    // No resolver answered: report nothing rather than guess.
    return result ? dnsAidFindings(host, result) : [];
  },
  tier: "network",
};
