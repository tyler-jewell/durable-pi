import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, redact } from "../src/redact.js";

const key = "cfat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";

test("redact scrubs exact known secret values anywhere in text", () => {
  const secret = "dpi_my-super-secret-device-token-1234";
  assert.equal(redact(`token=${secret}`, [secret]), `token=${REDACTED}`);
  assert.equal(redact(`a ${secret} b ${secret}`, [secret]), `a ${REDACTED} b ${REDACTED}`);
  // Surrounding text is preserved.
  assert.equal(redact(`[info] using ${secret} for auth`, [secret]), `[info] using ${REDACTED} for auth`);
});

test("redact scrubs common credential shapes without known values", () => {
  assert.equal(redact("Authorization: Bearer abcDEF123._~-xYz"), `Authorization: ${REDACTED}`);
  assert.equal(redact(`key=${key}`), `key=${REDACTED}`);
  assert.equal(redact("export OPENAI_API_KEY=sk-1234567890abcdefghij"), `export OPENAI_API_KEY=${REDACTED}`);
  assert.equal(redact("aws_access_key_id = AKIAIOSFODNN7EXAMPLE"), `aws_access_key_id = ${REDACTED}`);
  assert.equal(redact("token: dpi_abcdefghijklmnopqrstuvwxyz"), `token: ${REDACTED}`);
});

test("redact scrubs PEM private keys in full", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----`;
  assert.equal(redact(`\n${pem}\n`), `\n${REDACTED}\n`);
});

test("redact leaves ordinary text alone", () => {
  const text = "compiled 3 files in 1.2s — no changes";
  assert.equal(redact(text), text);
  // Short values are not treated as secrets.
  assert.equal(redact("abc", ["ab"]), "abc");
});

test("redact is not a guarantee: it only scrubs recognized values", () => {
  // An obfuscated secret is out of scope — the real protection is not having the secret at all.
  const secret = "dpi_my-secret";
  const obfuscated = Buffer.from(secret).toString("base64");
  assert.equal(redact(obfuscated, [secret]), obfuscated);
});
