# GitHub 심사 접근과 제출 기준 커밋

2026년 11월 14일 사용자 지시로 [가치타 GitHub 저장소](https://github.com/team-pitcrew/gachita)를 공개했습니다. 기본 브랜치는 develop입니다. 인증 없는 요청으로 저장소와 APK 경로를 읽었고, APK 전체를 다운로드해 SHA-256이 검증한 파일과 같은지 확인했습니다. 심사용 계정 초대는 필요하지 않습니다.

[최신 공식 제출 안내](https://appdevchallenge.auto-hmg.io/guide/submission)와 [FAQ](https://appdevchallenge.auto-hmg.io/faq)는 접수 메일에 저장소 주소와 최종 커밋 번호를 적도록 안내합니다. 심사는 그 커밋을 기준으로 진행하며, 공개 상태는 1차 심사 결과 발표일인 11월 23일까지 유지해야 합니다. 이전 보관 자료의 ‘심사 계정 초대’ 조건은 최신 규정과 달라 정정했습니다.

## 익명 접근 확인

- GitHub 저장소 API와 `apk/` 경로: 로그인·인증 헤더 없이 HTTP 200, 저장소 `private=false`.
- APK: [고정 커밋의 파일](https://github.com/team-pitcrew/gachita/blob/b458b54c4ff05a11fa48dc10d56035bf22815bf1/apk/PITCREW_%EA%B0%80%EC%B9%98%ED%83%80_release.apk)을 인증 없이 전체 다운로드했습니다. 48,789,550바이트이며 SHA-256은 `7bafb82e90756425597fe208ce12431fc09953152375aae728319750813c1e6b`입니다.
- 공개 전 로컬에 받아 둔 원격 이력 509개 커밋을 gitleaks로 검사했고 탐지된 비밀 값은 없었습니다. 로컬 서명 키·환경 파일·런타임 토큰은 저장소에 추가하지 않았습니다.
- 준비했던 소스·APK ZIP은 사용자 Drive에 비공개로 유지합니다. 심사 접근 경로는 GitHub입니다.
- 공개 전환 뒤 외부 기여자의 포크 PR은 매번 실행 승인이 필요하도록 설정했습니다(`all_external_contributors`). 자체 러너의 신뢰 범위는 [개발 규칙](development.md)에 있습니다.

위 다운로드에 사용한 커밋은 접근 검증 기준입니다. 추가 수정이 develop에 병합되면 최종 전달 명세에서 검토할 전체 커밋 SHA를 다시 고정합니다. 접수 메일에는 브랜치 주소만 적지 않습니다.

## 기획 검토용 전달 파일

[현재 UI 세로 검토 영상](../frontend/car/verification/20261114/current-ui-review.mp4)은 54.96초, 1080×1920 H.264/AAC입니다. 전체 구간에 ‘Pleos 에뮬레이터 실행 화면 · 합성 음성’을 표시했습니다. 공개 GitHub의 [T13 이슈](https://github.com/team-pitcrew/gachita/issues/14), README와 이 문서에서 같은 파일을 받을 수 있습니다. 이는 검토본을 열람할 수 있게 전달한 상태이며, 기획 담당의 최종 편집 승인이나 SNS 게시를 뜻하지 않습니다.

APK 실행 환경은 Pleos Connect Emulator 2.1.0, Android 14/API 34/arm64, 2560×1440 px(160 dpi)입니다. 앱 창과 반쪽 창 범위는 [README](../README.md)와 [에뮬레이터 명세](emulator/README.md)에 있습니다. 동일 release의 공개 서버 연결을 별도 AVD에서 확인했으며, 실차 검증은 수행하지 않았습니다. 합성 전사의 실패 조건과 실제 iPhone 검증 상태는 [제출 준비](submission-readiness.md) 및 [기기 확인](device-acceptance.md)에 그대로 남깁니다.

## 접수 메일에 넣을 항목

저장소 주소, 최종 전체 커밋 SHA, `apk/PITCREW_가치타_release.apk` 경로와 SHA-256, 실행 환경 및 검증 범위를 적습니다. 이번 개발 작업은 소스·APK·영상의 공개 접근과 검토본 전달을 준비한 것입니다. 접수 메일 발송, 기획서·동의서 제출은 별도 제출 작업입니다.
