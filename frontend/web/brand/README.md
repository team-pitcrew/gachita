# 가치타 대표 이미지

웹의 대표 이미지는 차 앱 런처와 같은 가치타 로고입니다. 로고는 `mascot.svg`(아래)의 경로를 그대로 `#12110F` 타일 가운데에 둔 그림이며, 새로 그린 그림이 아닙니다. 비율은 차 앱의 적응형 아이콘과 같습니다. 차 앱은 108dp 바탕(`#12110F`)에 `mascot.xml`을 사방 26% 떼어 얹고, 보이는 72dp 안에서 로고 상자가 72%(사방 14%)입니다. 웹 타일도 로고 상자 72%, 모서리 반지름 23%입니다. 192 PNG의 흰 몸통 (43,56)–(148,135), 초록 점 (122,45)–(147,69), 바탕 색은 에뮬레이터에 설치한 차 앱(11/15 시연 빌드)의 xxxhdpi 런처 PNG와 1px 안에서 같습니다. 차 앱 런처를 로고로 바꾸는 변경은 `frontend/car` 쪽에서 따로 올라갑니다.

| 사용처 | 파일 | 원본 SVG | 크기 |
| --- | --- | --- | --- |
| 브라우저 탭(SVG) | `../icon.svg` | 그 자체(둥근 타일) | 벡터 |
| 브라우저 탭(PNG) | `../icons/gachita-32.png` | `../icon.svg` | 32×32 |
| Apple 홈 화면 | `../icons/gachita-180.png` | `gachita-logo-full.svg`(정사각형, OS가 모서리를 깎음) | 180×180 |
| 웹 앱 설치(any) | `../icons/gachita-192.png`, `../icons/gachita-512.png` | `../icon.svg` | 192×192, 512×512 |
| 웹 앱 설치(maskable) | `../icons/gachita-maskable-512.png` | `gachita-logo-maskable.svg` | 512×512 |
| 화면 머리 브랜드 표시(로딩 화면 등 `.brand::before`) | `../icons/gachita-192.png` | `../icon.svg` | 32px로 표시 |
| 링크 미리보기(`og:image`, `twitter:image`) | `gachita-social.png` | `gachita-social.svg` | 1200×630 |

PNG는 headless Chromium으로 SVG를 정확한 픽셀 크기(기기 배율 1, 투명 바탕)로 찍었습니다. headless 창의 보이는 영역이 창 크기보다 작게 잡혀 아래가 잘리는 일이 있어, 넉넉한 창에서 찍고 왼쪽 위 W×H만 잘랐습니다. 링크 미리보기의 글꼴은 Pretendard(굵게 700·보통 500)입니다.

maskable 아이콘은 마스크가 바깥을 잘라도 다른 아이콘과 비슷한 크기로 보이게 로고 상자를 60%로 줄였습니다. 로고의 가장 먼 점은 중심에서 29.6%로, [Web App Manifest](https://www.w3.org/TR/appmanifest/#icon-masks)의 안전 반지름 40% 안입니다. 정사각형 180의 가장 먼 점은 35.4%입니다. 이 검수는 자산 검수이며, 기기에 설치한 홈 화면 아이콘의 검수와 구분합니다.

`gachita-app-icon-master.png`(1254×1254, SHA-256 `7fb71cf97bcf6a247e59b5decda8d11f8205136f6546e6b53a21a78ddce81db2`)는 T108에서 쓴 옛 대표 캐릭터(흰 전신, 민트 바탕) 원본입니다. 웹은 더 쓰지 않지만, `develop`의 차 앱 런처 그림(`../../car/app/src/main/res/drawable-nodpi/gachita_launcher_art.png`)이 아직 이 원본에서 나왔으므로 남겨 둡니다. 기본 캐릭터 20종(`../chars/`)과는 별개입니다.

`mascot.svg`는 최종 시안(민준 개선안)의 가치타 본체 마스코트 `Mascot`(Figma 노드 `7:544`, 상태=기록 중) 24×24 선 그림입니다. 폰 머리 줄(app bar)에 씁니다. Figma MCP의 에셋 주소에서 받은 SVG에서 표시용 속성(`style`, `preserveAspectRatio`)과 레이어 id만 지웠고 경로는 그대로입니다. 위 로고 아이콘도 이 경로를 그대로 씁니다.

## 첫 화면(P01) 보관함 카드 그림

`welcome-dad.png`·`welcome-seojun.png`(192×192)는 최신 시안 P01(`eZ2xsOXkrszqdP489kduCs` 2073:3697 'Archive / 캐릭터 / 아빠·서준')의 그림을 그대로 받은 것입니다. 기본 캐릭터(`../chars/`)와 자르기·바탕이 달라 따로 둡니다.
