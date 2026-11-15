# 웹 대표 이미지를 차 앱 로고로 (11/15)

로컬 서버(이 브랜치, 8797)와 ego lite 브라우저에서 확인했습니다. 실제 폰 홈 화면이나 카카오톡 공유 미리보기에서 확인한 것은 아닙니다.

| 사진 | 무엇 |
|---|---|
| `icons-side-by-side.png` | 기준(에뮬레이터 Dock의 차 앱 아이콘, 설치된 APK의 xxxhdpi 런처 PNG)과 웹이 선언한 모든 대표 이미지: 탭 아이콘(`/icon.svg` 16·32·120px, `/icons/gachita-32.png`), Apple 홈 화면(180, 둥근 마스크), manifest any 192·512, maskable 512(원·둥근 사각 마스크), 로딩 화면 머리(`.top .brand`, 실제 CSS), 링크 미리보기(`/brand/gachita-social.png`) |
| `app-missing-trip-390.png` | 실제 화면: 없는 여행 주소(`/#ZZZZZZ`)의 '여행을 찾지 못했어요'. 머리의 `.brand::before`가 `/icons/gachita-192.png`(로고)를 그린다. 390×844, 어두운 화면 |

브라우저에서 읽은 값:

- `link rel=icon` 두 개(`/icons/gachita-32.png`, `/icon.svg`), `apple-touch-icon`(`/icons/gachita-180.png`), manifest 아이콘 세 개, `og:image`·`twitter:image`(`/brand/gachita-social.png`) 일곱 개 모두 200으로 받아 그림으로 풀렸습니다(32·192·180·192·512·512·1200×630).
- `Page.getAppManifest` 오류 없음. `og:image:alt`는 '어두운 타일 위의 가치타 로고와 가치타 이름'.
- 브라우저 탭 줄 자체는 찍지 못했습니다(ego lite 창이 다른 데스크톱 공간에 있음). 탭이 쓰는 파일은 위 `link rel=icon` 두 개입니다.
