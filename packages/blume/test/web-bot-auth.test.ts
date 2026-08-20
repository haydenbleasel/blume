import { describe, expect, it } from "bun:test";

import {
  buildSignaturesDirectory,
  SIGNATURES_DIRECTORY_PATH,
  SIGNATURES_DIRECTORY_TYPE,
} from "../src/ai/web-bot-auth.ts";
import type { BlumeConfig } from "../src/core/config-input.ts";
import { blumeConfigSchema } from "../src/core/schema.ts";
import type { ResolvedConfig } from "../src/core/schema.ts";

const ED25519_PUBLIC = {
  crv: "Ed25519",
  kty: "OKP",
  x: "JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs",
};

const parseAi = (webBotAuth: NonNullable<BlumeConfig["ai"]>["webBotAuth"]) =>
  blumeConfigSchema.safeParse({ ai: { webBotAuth } });

const configWith = (
  keys: ResolvedConfig["ai"]["webBotAuth"]["keys"]
): ResolvedConfig =>
  // SAFETY: buildSignaturesDirectory reads only the configured keys.
  ({ ai: { webBotAuth: { keys } } }) as ResolvedConfig;

describe("ai.webBotAuth schema", () => {
  it("defaults to no keys and accepts a public JWK", () => {
    expect(blumeConfigSchema.parse({}).ai.webBotAuth.keys).toEqual([]);
    const parsed = parseAi({ keys: [ED25519_PUBLIC] });
    expect(parsed.success).toBe(true);
  });

  it("requires the mandatory kty parameter", () => {
    const parsed = parseAi({ keys: [{ crv: "Ed25519" }] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("key type");
  });

  it("rejects a JWK carrying private key material", () => {
    for (const leak of [
      { ...ED25519_PUBLIC, d: "SECRET" },
      { k: "SECRET", kty: "oct" },
      { dp: "x", dq: "x", e: "AQAB", kty: "RSA", n: "x", p: "x", q: "x" },
    ]) {
      const parsed = parseAi({ keys: [leak] });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain(
        "private key material"
      );
    }
  });
});

describe("buildSignaturesDirectory", () => {
  it("serializes the configured keys as a JWKS", () => {
    const directory = buildSignaturesDirectory(configWith([ED25519_PUBLIC]));
    expect(JSON.parse(directory ?? "")).toEqual({ keys: [ED25519_PUBLIC] });
    expect(directory?.endsWith("\n")).toBe(true);
  });

  it("returns null when no keys are configured", () => {
    expect(buildSignaturesDirectory(configWith([]))).toBeNull();
  });

  it("pins the draft's path and media type", () => {
    expect(SIGNATURES_DIRECTORY_PATH).toBe(
      "/.well-known/http-message-signatures-directory"
    );
    expect(SIGNATURES_DIRECTORY_TYPE).toBe(
      "application/http-message-signatures-directory+json"
    );
  });
});
