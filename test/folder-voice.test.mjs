import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFolder } from "../lib/folder-voice.mjs";

const folders = [
  { path: "/Users/me/workspace/voin", name: "voin", alias: "보인" },
  { path: "/Users/me/Documents/팀 회의", name: "팀 회의", alias: "" },
  { path: "/Users/me/blog", name: "blog", alias: "블로그" },
];

test("폴더만 바꾸는 말", () => {
  assert.deepEqual(matchFolder("보인 폴더로 바꿔 줘", folders), { path: "/Users/me/workspace/voin", rest: "" });
  assert.deepEqual(matchFolder("작업 폴더 블로그로 바꿔", folders), { path: "/Users/me/blog", rest: "" });
  assert.deepEqual(matchFolder("팀회의 폴더 열어", folders), { path: "/Users/me/Documents/팀 회의", rest: "" }); // 띄어쓰기가 달라도
  assert.deepEqual(matchFolder("보인.", folders), { path: "/Users/me/workspace/voin", rest: "" });
});

test("폴더를 바꾸고 이어지는 말은 작업으로", () => {
  assert.deepEqual(matchFolder("보인에서 테스트 돌려 줘", folders), { path: "/Users/me/workspace/voin", rest: "테스트 돌려 줘" });
  assert.deepEqual(matchFolder("Voin 폴더에서, README 고쳐 줘", folders), { path: "/Users/me/workspace/voin", rest: "README 고쳐 줘" });
});

test("폴더 이름으로 시작하지 않으면 그대로 작업", () => {
  assert.equal(matchFolder("테스트 돌려 줘", folders), null);
  assert.equal(matchFolder("보인다고 생각해?", folders), null); // 이름 뒤에 바로 다른 글자가 붙으면 아님
  assert.equal(matchFolder("블로그 글 하나 써 줘", folders), null); // 조사·바꿔 같은 말 없이 이어지면 작업으로 본다
});
