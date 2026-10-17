import { test } from "node:test";
import assert from "node:assert/strict";
import { datesSpoken, numbersSpoken, numbersWarning, sinoKorean, uncheckedNumbers } from "../lib/summary-check.mjs";

test("한자어 숫자 읽기", () => {
  assert.equal(sinoKorean("이십"), 20);
  assert.equal(sinoKorean("십사"), 14);
  assert.equal(sinoKorean("삼백오십"), 350);
  assert.equal(sinoKorean("이천이십육"), 2026);
  assert.equal(sinoKorean("만오천"), 15000);
});

test("기록 속 날짜: '월' 뒤의 '…일'은 날짜라 끝의 일을 숫자로 읽지 않는다", () => {
  assert.deepEqual([...datesSpoken("네 십일월 이십일 그대로 갑니다")], ["11-20"]);
  assert.deepEqual([...datesSpoken("십일월 이십일일까지")], ["11-21"]);
  assert.deepEqual([...datesSpoken("11월 7일까지, 그리고 November twentieth, December 3")], ["11-7", "11-20", "12-3"]);
});

test("기록 속 숫자: 한글·영어·아라비아 숫자를 모두 읽는다", () => {
  const spoken = numbersSpoken("오 달러로 하고 서른 명, 십사일까지. fourteen days, two crashes. 버전 2.5, 8GB");
  for (const n of [5, 30, 14, 2, 2.5, 8]) assert.ok(spoken.has(n), `${n}`);
});

test("요약 확인: 기록과 다른 날짜, 기록에 없는 숫자를 고른다", () => {
  const transcript = "[00:00:48] **화자 1**: 네 십일월 이십일 그대로 갑니다. 환불은 fourteen days, 가격은 오 달러.";
  assert.deepEqual(uncheckedNumbers("- 출시일 11월 20일\n- 환불 14일\n- 가격 5달러\n- [ ] 화자 3: 로그 전달", transcript), []);
  // 실제로 겪은 오류: 기록은 11월 20일인데 요약이 21일
  assert.deepEqual(uncheckedNumbers("- 출시일은 11월 21일로 확정되었다.", transcript), ["11월 21일"]);
  assert.deepEqual(uncheckedNumbers("- 가격 7달러\n- 화자 2가 말함", transcript), ["7달러"]); // "화자 2"는 숫자로 보지 않음
  assert.deepEqual(uncheckedNumbers("8. 출시 행사는 별도 결정\n  12) 기타", transcript), []); // 줄 앞 목록 번호
});

test("경고 문구: 없으면 비움", () => {
  assert.equal(numbersWarning([]), "");
  assert.match(numbersWarning(["11월 21일", "7달러"]), /11월 21일, 7달러/);
});
