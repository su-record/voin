import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalRequest } from "../lib/request-guard.mjs";

const PORT = 4310;

test("앱 화면(같은 출처)과 앱·도구의 직접 요청은 받는다", () => {
  assert.ok(isLocalRequest({ host: "localhost:4310", origin: "http://localhost:4310" }, PORT));
  assert.ok(isLocalRequest({ host: "127.0.0.1:4310", origin: "http://127.0.0.1:4310" }, PORT));
  assert.ok(isLocalRequest({ host: "localhost:4310" }, PORT)); // 맥 앱(URLRequest)·승인 MCP는 Origin 없이 보낸다
});

test("다른 사이트에서 보낸 요청은 거절한다", () => {
  assert.equal(isLocalRequest({ host: "localhost:4310", origin: "https://evil.example" }, PORT), false);
  assert.equal(isLocalRequest({ host: "localhost:4310", origin: "null" }, PORT), false);
  assert.equal(isLocalRequest({ host: "localhost:4310", origin: "http://localhost:3000" }, PORT), false);
});

test("DNS 리바인딩(다른 주소 이름으로 들어온 요청)은 거절한다", () => {
  assert.equal(isLocalRequest({ host: "evil.example:4310", origin: "http://evil.example:4310" }, PORT), false);
  assert.equal(isLocalRequest({ host: "evil.example:4310" }, PORT), false);
  assert.equal(isLocalRequest({}, PORT), false);
});
