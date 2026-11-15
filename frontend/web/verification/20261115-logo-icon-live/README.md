# 웹 대표 이미지 로고: 실제 주소 확인 (11/15)

PR #603(로고 교체)과 배포 PR #604(이미지 `93772bf7116d`)가 병합되고 Argo CD 롤아웃·live-e2e가 통과한 뒤, `https://gachita.mangowhois.ai`를 ego lite 브라우저(390×844)에서 확인했습니다. 실제 폰 홈 화면이나 메신저 링크 미리보기에서 확인한 것은 아닙니다.

| 사진 | 무엇 |
|---|---|
| `demo-390.png` | `/demo/` 첫 화면. 머리의 브랜드 그림과 가운데 `welcome-mark` 둘 다 `/icons/gachita-192.png`(로고) |
| `brand-mark-dark-zoom.png` | 없는 여행 주소(`/#ZZZZZZ`) 머리의 32px 브랜드 표시(`.top .brand::before`), 어두운 화면, 기기 배율 3을 4배로 확대 |
| `brand-mark-light-zoom.png` | 같은 자리, 밝은 화면 |

- 실제 주소의 `icon.svg`, `icons/gachita-32·180·192·512.png`, `icons/gachita-maskable-512.png`, `brand/gachita-social.png`, `manifest.webmanifest` 여덟 개가 저장소 파일과 바이트 단위로 같습니다(sha1 비교).
- `link rel=icon`·`apple-touch-icon`·manifest 아이콘·`og:image`·`twitter:image`가 모두 로고 파일을 가리키고, `Page.getAppManifest` 오류가 없습니다.
- 32px 브랜드 표시는 `.brand::before`의 바탕색(`--accent-soft`, 밝은 화면 `#e4f4ec`·어두운 화면 `#1c3a2d`) 위에 로고 PNG를 얹습니다. CSS 모서리(10px)가 타일 모서리(약 7.4px)보다 커서 바탕색이 가려집니다. 두 확대 사진에서 타일 가장자리 3px 안에 초록 기운이 도는 픽셀(G−R>12)은 0개였습니다. 보이지 않아 CSS는 바꾸지 않았습니다. Safari 같은 다른 렌더러에서는 확인하지 않았습니다.
- 첫 화면(`/`)의 머리 브랜드 표시는 `brand/mascot.svg`(로고)입니다. 그 화면의 캐릭터 그림은 로그인한 사람의 프로필·콘텐츠 그림이라 대표 이미지가 아닙니다.
