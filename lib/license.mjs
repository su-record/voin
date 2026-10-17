// 허용 키: 유료 기능(예: 어디서든 휴대폰 마이크)을 여는 키. 결제 연동 전에는 직접 발급하고(scripts/issue-key.mjs),
// 나중에 결제가 끝나면 같은 형식으로 자동 발급한다.
// 형식: voin1.<내용 base64url>.<Ed25519 서명 base64url>. 내용은 { sub(누구), features(기능), expires(YYYY-MM-DD) }.
// 앱과 중계에는 공개 열쇠만 들어 있어 서명만 확인한다 (서버·데이터베이스 없음, 위조 불가).
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const LICENSE_PUBLIC_KEY = "4BiJiG-TtNwwsqhLel1R8VXm9TZVotrijVXpm7HXR4Q"; // 발급 비밀 열쇠: 발급자 맥의 ~/.config/voin/license-private.pem
const PREFIX = "voin1";
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex"); // 32바이트 공개 열쇠 앞에 붙는 고정 머리

const publicKeyObject = (raw) => createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(raw, "base64url")]), format: "der", type: "spki" });

export function issueKey({ sub, features, expires }, privateKey) {
  const payload = Buffer.from(JSON.stringify({ sub, features, expires })).toString("base64url");
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const signature = sign(null, Buffer.from(`${PREFIX}.${payload}`), key).toString("base64url");
  return `${PREFIX}.${payload}.${signature}`;
}

// → { ok: true, payload } | { ok: false, reason: "format" | "signature" | "expired", payload? }
export function verifyKey(key, publicKey = LICENSE_PUBLIC_KEY, now = Date.now()) {
  const parts = String(key ?? "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "format" };
  // 표준 base64url만 받는다: 다시 써 봐서 같지 않으면(끝 글자의 남는 비트만 다른 키 등) 거절
  const canonical = (s) => Buffer.from(s, "base64url").toString("base64url") === s;
  if (!canonical(parts[1]) || !canonical(parts[2])) return { ok: false, reason: "format" };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "format" };
  }
  const signed = verify(null, Buffer.from(`${PREFIX}.${parts[1]}`), publicKeyObject(publicKey), Buffer.from(parts[2], "base64url"));
  if (!signed) return { ok: false, reason: "signature" };
  // expires 날짜가 끝날 때까지(그날 포함, UTC) 쓸 수 있다
  if (payload.expires && now >= Date.parse(`${payload.expires}T00:00:00Z`) + 24 * 3600 * 1000) return { ok: false, reason: "expired", payload };
  return { ok: true, payload };
}

export function hasFeature(key, feature, publicKey = LICENSE_PUBLIC_KEY, now = Date.now()) {
  const result = verifyKey(key, publicKey, now);
  return result.ok && Array.isArray(result.payload.features) && result.payload.features.includes(feature);
}
