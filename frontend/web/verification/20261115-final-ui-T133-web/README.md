# 흐름 F2 폰: 가족·동승 그룹·초대·아이·좌석·폰 참여(T133)

2026-11-15 macOS의 Ego Lite(데스크톱 Chromium)에서 CDP로 390×844·모바일·밝은 테마를 흉내 내어 찍었습니다. **실제 폰에서 본 것이 아닙니다.** 기준은 Figma v2(`GISs0yf3c1KCjXwuFmF4ij`, 페이지 `2004:57`).

서버는 그룹 API PR(#386, `feature/T133-api-groups`)의 `backend/api`와 이 브랜치의 `frontend/web`을 한 폴더에 모아 자기 포트(8873)·자기 Postgres 컨테이너로 띄웠습니다(공용 `gachita-pg`는 쓰지 않음). 계정·그룹·아이·목소리 값·좌석은 API로 넣은 합성 값이고 토큰과 개인 정보는 남기지 않았습니다.

| 파일 | 프레임 | 부른 API |
|---|---|---|
| P09-member.png | P09 우리 가족 추가(그룹 없음) | `GET /groups`, `GET /profiles/me` |
| P39-mom-joined.png | P39 엄마 연결 후 | `GET /groups` |
| P10-invite.png | P10 가족 초대(코드·QR·링크) | `POST /groups/{id}/invites` |
| P-share-family.png / P-share-trip.png | 초대 링크 공유 FAMILY·TRIP(2047:2316·2333) | 없음(공유 화면) |
| P-copied.png | 초대 복사 알림(2047:2313) | 없음(클립보드). 자동화 브라우저에 클립보드 권한이 없어 실패 문구가 보임 — 알림 자리와 모양만 확인 |
| P11-child.png | P11 아이 프로필 | (다음 단추) `POST /groups/{id}/children` |
| P12-child-voice.png | P12 아이 목소리 15초 | **목업**: 15초 진행만. 값 올리기(`POST /groups/{id}/members/{profileId}/voice` JSON)는 웹 임베더(흐름 F1) 병합 뒤 |
| P40-son-ready.png | P40 서준 등록 후 | `GET /groups` |
| P13-group.png | P13 우리 가족(좌석 지도) | `GET /groups` |
| P14-seat-swapped.png | P14 좌석 바꾸기(서준↔하은) | 화면에서 맞바꿈 |
| P43-saved-seats.png | P43 저장된 새 좌석 | `PUT /groups/{id}/seats` |
| P15-guest.png | P15 새 동승 그룹 | (다음 단추) `POST /groups {kind:"guest"}` |
| P16-guest-invite.png | P16 동승자 초대(TRIP) | `POST /groups/{id}/invites` |
| phoneJoin.png / phoneGuestJoin.png | QR·링크 참여(`/?group=코드`) | `GET /group-invites/{code}`(토큰 없이: 그룹·대표 이름) |
| phoneJoined.png / phoneGuestJoined.png | 참여 완료 | `PATCH /profiles/me {consent:true}`, `POST /group-invites/{code}` |

다른 점: 시안의 '엄마의 계정 초대하기'·'하은 프로필 만들기'처럼 이름이 든 단추는 '가족 계정 초대하기'·'다음 아이 프로필 만들기'로 둡니다(누가 올지 모름). 탭(대화 기록·콘텐츠 기록)은 그룹 화면을 닫고 앱으로 돌아갑니다.
