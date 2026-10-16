import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDictionary, cleanupDictation, dictionaryTerms, dictionaryToText, normalizeDictionary,
  parseDictionaryText, removeFillers, removeRepetitions,
} from "../lib/text-cleanup.mjs";

test("사전: 낱말 경계 기준 치환, 조사는 붙어도 됨", () => {
  const d = [{ from: "쿠버네티스", to: "Kubernetes" }, { from: "지피티", to: "GPT" }];
  assert.equal(applyDictionary("쿠버네티스에 배포하고 지피티로 요약", d), "Kubernetes에 배포하고 GPT로 요약");
});
test("사전: 낱말 중간은 안 바꿈", () => {
  assert.equal(applyDictionary("cat category", [{ from: "cat", to: "Cat" }]), "Cat category");
  assert.equal(applyDictionary("새쿠버", [{ from: "쿠버", to: "K" }]), "새쿠버");
});
test("사전: 긴 말 우선, 영문 대소문자 무시", () => {
  const d = [{ from: "voin", to: "voin" }, { from: "보인", to: "voin" }, { from: "보인 앱", to: "voin 앱" }, { from: "grok", to: "Grok" }];
  assert.equal(applyDictionary("보인 앱은 GROK 연동", d), "voin 앱은 Grok 연동");
});
test("사전: 정규식 특수문자 안전", () => {
  assert.equal(applyDictionary("씨쁠쁠 좋아", [{ from: "씨쁠쁠", to: "C++" }]), "C++ 좋아");
  assert.equal(applyDictionary("a.b 와 axb", [{ from: "a.b", to: "AB" }]), "AB 와 axb");
});
test("사전: 파싱·정규화·용어", () => {
  const d = parseDictionaryText("쿠버네티스 => Kubernetes\n\n  Sutory \n지피티 → GPT\n쿠버네티스 => X");
  assert.deepEqual(d, [{ from: "쿠버네티스", to: "Kubernetes" }, { from: "Sutory", to: "Sutory" }, { from: "지피티", to: "GPT" }]);
  assert.equal(dictionaryToText(d), "쿠버네티스 => Kubernetes\nSutory\n지피티 => GPT");
  assert.deepEqual(dictionaryTerms(d), ["Kubernetes", "Sutory", "GPT"]);
  assert.deepEqual(normalizeDictionary("x"), []);
  assert.equal(applyDictionary("", d), "");
});
test("군말: 뜻 없는 소리는 지움", () => {
  assert.equal(removeFillers("음 오늘 회의는 um 세 시야"), "오늘 회의는 세 시야");
  assert.equal(removeFillers("음... 그러니까 uh, 내일 하자"), "그러니까 내일 하자");
  assert.equal(removeFillers("So, um, I think uh we should go"), "So, I think we should go");
});
test("군말: 쉼표로 떨어진 어/그/저기/you know만 지움", () => {
  assert.equal(removeFillers("어, 그, 저기, 이거 봐"), "이거 봐");
  assert.equal(removeFillers("It is, you know, fine"), "It is, fine");
});
test("군말: 뜻 있는 말은 보존", () => {
  for (const s of ["그 사람이 왔어", "저기 있어", "어 맞아", "어디 가?", "음식 먹자", "그래서 그렇게 했어", "umbrella 챙겨", "you know what I mean"]) {
    assert.equal(removeFillers(s), s);
  }
});
test("반복: 바로 이어진 반복만 하나로", () => {
  assert.equal(removeRepetitions("제가 제가 할게요"), "제가 할게요");
  assert.equal(removeRepetitions("I think I think so"), "I think so");
  assert.equal(removeRepetitions("the the cat"), "the cat");
  assert.equal(removeRepetitions("1 1 2"), "1 1 2");
  assert.equal(removeRepetitions("하나 둘 하나"), "하나 둘 하나");
  assert.equal(removeRepetitions("가나 가나다"), "가나 가나다");
});
test("받아쓰기 후처리: 사전 → 군말", () => {
  const d = [{ from: "지피티", to: "GPT" }];
  assert.equal(cleanupDictation("음 지피티 지피티한테 물어봐", { dictionary: d }), "GPT GPT한테 물어봐");
  assert.equal(cleanupDictation("음 지피티", { dictionary: d, removeFillers: false }), "음 GPT");
});
