import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { hasFeature, issueKey, verifyKey } from "../lib/license.mjs";

// 시험용 열쇠 (실제 발급 열쇠와 다름)
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
const now = Date.parse("2026-10-18T00:00:00Z");

test("발급한 키는 확인을 통과하고 내용을 돌려준다", () => {
  const key = issueKey({ sub: "teammate@example.com", features: ["anywhere-mic"], expires: "2027-10-18" }, privateKey);
  assert.match(key, /^voin1\.[\w-]+\.[\w-]+$/);
  const r = verifyKey(key, pub, now);
  assert.equal(r.ok, true);
  assert.equal(r.payload.sub, "teammate@example.com");
  assert.equal(hasFeature(key, "anywhere-mic", pub, now), true);
  assert.equal(hasFeature(key, "다른-기능", pub, now), false);
});

test("고친 키·다른 열쇠·만료·엉뚱한 글은 거절", () => {
  const key = issueKey({ sub: "a", features: ["anywhere-mic"], expires: "2026-10-17" }, privateKey);
  assert.deepEqual(verifyKey(key, pub, now), { ok: false, reason: "expired", payload: JSON.parse(Buffer.from(key.split(".")[1], "base64url")) });
  const good = issueKey({ sub: "a", features: ["anywhere-mic"], expires: "2027-01-01" }, privateKey);
  const [v, p, s] = good.split(".");
  const tampered = `${v}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), expires: "2099-01-01" })).toString("base64url")}.${s}`;
  assert.equal(verifyKey(tampered, pub, now).reason, "signature");
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url");
  assert.equal(verifyKey(good, other, now).reason, "signature");
  // 마지막 글자만 바꿔 같은 바이트로 읽히는 "다른 모양" 키도 거절 (표준 형태만 받는다)
  // 64바이트 서명은 86글자라 마지막 글자의 아래 4비트가 남는다: 그 비트만 바꾸면 같은 바이트로 읽힌다
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const loose = good.slice(0, -1) + ALPHABET[ALPHABET.indexOf(good.at(-1)) | 1];
  assert.deepEqual(Buffer.from(loose.split(".")[2], "base64url"), Buffer.from(good.split(".")[2], "base64url"));
  assert.notEqual(verifyKey(loose, pub, now).ok, true);
  const middle = good.slice(0, -10) + (good.at(-10) === "x" ? "y" : "x") + good.slice(-9);
  assert.equal(verifyKey(middle, pub, now).reason, "signature");
  assert.equal(verifyKey("아무 글", pub, now).reason, "format");
  assert.equal(verifyKey("", pub, now).reason, "format");
});
