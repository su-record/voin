// 허용 키 발급 (발급자 맥에서만): node scripts/issue-key.mjs --sub "이름 또는 이메일" --expires 2027-10-18 [--features anywhere-mic]
// 서명 비밀 열쇠는 저장소 밖 ~/.config/voin/license-private.pem (잃어버리면 새로 만들고 앱의 공개 열쇠도 바꿔야 한다)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { issueKey, verifyKey } from "../lib/license.mjs";

const { values } = parseArgs({ options: { sub: { type: "string" }, expires: { type: "string" }, features: { type: "string", default: "anywhere-mic" } } });
if (!values.sub || !/^\d{4}-\d{2}-\d{2}$/.test(values.expires ?? "")) {
  console.log('사용법: node scripts/issue-key.mjs --sub "이름 또는 이메일" --expires YYYY-MM-DD [--features anywhere-mic]');
  process.exit(1);
}
const privateKey = fs.readFileSync(path.join(os.homedir(), ".config/voin/license-private.pem"), "utf8");
const key = issueKey({ sub: values.sub, features: values.features.split(","), expires: values.expires }, privateKey);
const check = verifyKey(key);
if (check.reason === "expired") throw new Error("만료일이 이미 지났습니다. --expires를 오늘 이후로 주세요.");
if (!check.ok) throw new Error(`발급한 키가 앱의 공개 열쇠로 확인되지 않습니다 (${check.reason}). 비밀 열쇠와 lib/license.mjs의 공개 열쇠가 짝인지 확인하세요.`);
console.log(key);
