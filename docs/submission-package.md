# 소스와 APK의 심사 접근 준비

2026년 11월 14일 [공식 제출 안내](https://appdevchallenge.auto-hmg.io/guide/submission)와 [FAQ](https://appdevchallenge.auto-hmg.io/faq)를 다시 확인했습니다. 심사용 GitHub 계정을 초대할 필요가 없습니다. 저장소 주소와 최종 커밋 번호를 접수 메일에 적고, 심사는 해당 커밋을 기준으로 진행합니다. 이전에 보관한 안내의 계정 초대 조건은 최신 규정과 달라 바로잡습니다.

공식 안내에는 비공개 저장소를 11월 16일까지 공개하고 11월 23일까지 유지하는 경로와, 공개가 어려우면 소스와 APK 압축본의 다운로드 주소를 접수 마감 전 제출하는 경로가 있습니다. 현재 저장소는 비공개이므로 후자를 준비합니다. 압축본 준비, 다운로드 접근 확보, 최종 발송은 각각 확인합니다.

## 고정할 파일과 근거

- 최종 소스는 develop에 머지한 특정 커밋으로 고정합니다. 브랜치의 최신 상태를 가리키는 다운로드 링크만으로 대체하지 않습니다.
- 소스 압축본에는 추적 중인 소스와 `apk/PITCREW_가치타_release.apk`, README, 현재 UI 검토 영상, 검증 문서를 포함합니다.
- `.git` 이력, 무시된 파일, 로컬 설정, 서명 키, `.env`, 런타임 토큰과 실제 사용자 데이터를 추가하지 않습니다. 압축 직전 추적 파일 목록과 비밀 값 검사를 확인합니다.
- 압축본의 ZIP 무결성을 검사하고 APK가 이미 검증한 SHA-256 및 서명과 일치하는지 대조합니다. 최종 커밋·파일명·크기·SHA-256·검증 결과는 별도 전달 명세에 적습니다.
- 개발 환경은 Pleos Connect Emulator 2.1.0, Android 14/API 34/arm64, 2560×1440 px(160 dpi)입니다. 앱 창과 반쪽 창 범위는 [README](../README.md)와 [에뮬레이터 명세](emulator/README.md)에 있습니다.

깨끗한 작업 트리에서 승인된 커밋을 정한 뒤 다음과 같이 소스 묶음을 만들 수 있습니다. `COMMIT`에는 전달 명세에 기록할 실제 전체 SHA를 넣습니다.

```sh
git archive --format=zip --prefix=gachita/ --output=PITCREW_gachita_source-apk.zip COMMIT
unzip -t PITCREW_gachita_source-apk.zip
shasum -a 256 PITCREW_gachita_source-apk.zip
```

## 접근과 전달

현재 비공개 GitHub 링크는 심사자가 로그인 없이 받을 수 있는 주소가 아닙니다. 다운로드 링크를 만들 때는 고정한 압축본만 대상으로 삼고, 로그아웃 환경에서 파일 다운로드와 해시 일치를 확인합니다. 메일에는 저장소 주소, 전체 커밋 SHA, 압축본 주소, APK 경로와 SHA-256, 실행 환경 및 실제 확인 범위를 함께 적습니다.

이번 작업에서 준비한 검토 영상은 [54.96초 세로 영상](../frontend/car/verification/20261114/current-ui-review.mp4)입니다. 에뮬레이터·합성 음성을 표시했고, 전사 조건 하나가 실패한 한계는 [검증 기록](submission-readiness.md)에 보존했습니다. 기획 담당의 검토·최종 게시와 공모전 접수는 파일 준비만으로 완료 처리하지 않습니다.
