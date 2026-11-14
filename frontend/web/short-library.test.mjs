import test from "node:test";
import assert from "node:assert/strict";
import { shortMetadata, libraryGroups, tripDate } from "./short-library.js";

test("기기 영상에는 여행 정보만 복사하고 참가자 토큰과 서버 작업은 남기지 않는다", () => {
  const tripCreatedAt = Date.UTC(2026, 10, 14);
  const source = { title: "바다가 보인 순간", seconds: 24, tripCode: "TRIP12", tripTitle: "강릉 여행", tripCreatedAt, momentId: "scene", token: "secret", job: { result: { url: "/private" } }, remote: true, verify() {} };
  assert.deepEqual(shortMetadata(source), { title: source.title, seconds: 24, tripCode: "TRIP12", tripTitle: "강릉 여행", tripCreatedAt, momentId: "scene" });
  assert.deepEqual(shortMetadata({ tripCreatedAt: null }), { title: "우리 여행의 쇼츠", seconds: 0 });
});

test("여행 이름이 같아도 다른 여행의 쇼츠를 합치지 않고 여행·장면·날짜로 찾는다", () => {
  const first = { id: "1", title: "첫 번째 바다", tripTitle: "강릉 여행", tripCode: "ONE123", tripCreatedAt: Date.UTC(2026, 10, 14) };
  const second = { ...first, id: "2", title: "돌아오는 길", tripCode: "TWO123" };
  const groups = libraryGroups([first, second]);
  assert.equal(groups.length, 2);
  assert.deepEqual(libraryGroups([first, second], " 강릉 ").flatMap((g) => g.items), [first, second]);
  assert.deepEqual(libraryGroups([first, second], "돌아오는").flatMap((g) => g.items), [second]);
  assert.equal(libraryGroups([first], tripDate(first)).length, 1);
});

test("기존 보관 영상은 여행 이름과 날짜를 꾸미지 않고 계속 표시한다", () => {
  const old = { id: "old", title: "예전에 남긴 쇼츠" };
  assert.equal(tripDate(old), "");
  assert.deepEqual(libraryGroups([old]), [{ key: "device", title: "이 기기에 보관한 영상", date: "", items: [old] }]);
  assert.deepEqual(libraryGroups([old], "없는 여행"), []);
});
