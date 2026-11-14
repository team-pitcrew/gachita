# 흐름 F2 차: 가족·동승 그룹·초대·아이·좌석·'이 가족과 출발'(T133)

2026-11-15 emulator-5562(Pleos, 2560×1440, 주차 P)에서 찍은 **에뮬레이터 화면**입니다(실차 아님). 앱은 이 브랜치의 디버그 APK, 서버는 그룹 API(#386)를 자기 포트·자기 Postgres로 띄우고 `--es server http://10.0.2.2:<포트> --es profileToken <합성 계정 토큰> --ez family true`로 열었습니다. 계정·그룹·아이·좌석은 API로 넣은 합성 값입니다.

| 파일 | 프레임 | 부른 API |
|---|---|---|
| C39-member.png | C39·C40 가족 추가(엄마 연결·서준 등록 뒤) | `GET /api/groups`, `GET /api/profiles/me` |
| C10-invite.png | C10 가족 초대(코드·QR·링크) | `POST /api/groups/{id}/invites` |
| C11-child.png | C11 아이 프로필 | (다음 단추) `POST /api/groups/{id}/children` |
| C14-seat-swapped.png | C14 좌석 바꾸기(서준↔하은) | 화면에서 맞바꿈 |
| C43-saved-seats.png | C43·C13 저장된 좌석·우리 가족 | `PUT /api/groups/{id}/seats` |
| C15-guest.png | C15 새 동승 그룹 | (다음 단추) `POST /api/groups {kind:"guest"}` |
| C16-guest-invite.png | C16 동승자 초대(TRIP) | `POST /api/groups`, `POST /api/groups/{id}/invites` |
| C13-start-trip.png | '이 가족과 출발' 뒤 여행 화면(일행 4명, 저장된 자리) | `POST /api/trips {groupId}` → 참가자 토큰 |

찍지 못한 것: C13 단독(다른 흐름의 내비 안내가 위에 떠 있던 순간이라 버림 — 같은 화면은 C43), 복사 알림(전환 중 검은 화면이라 버림), C12·C42 아이 목소리(목업, 흐름 F1이 실제 소리로 바꿈), 프로필 토큰 없는 시연 가족(목업).
