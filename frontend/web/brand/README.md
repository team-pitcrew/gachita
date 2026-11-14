# 가치타 대표 이미지

웹과 차량 앱에서 같은 대표 캐릭터를 사용합니다. 흰색 전신 캐릭터의 두 팔과 두 발을 유지하며, 그림을 다시 그리지 않고 원본을 크기별로 줄였습니다. 기본 캐릭터 20종은 이 이미지와 별개입니다.

`gachita-app-icon-master.png`는 1254×1254 원본입니다. SHA-256은 `7fb71cf97bcf6a247e59b5decda8d11f8205136f6546e6b53a21a78ddce81db2`입니다.

| 사용처 | 파일 | 크기 |
| --- | --- | --- |
| 브라우저 탭 | `../icons/gachita-32.png` | 32×32 |
| SVG favicon | `../icon.svg` | 192 PNG를 내부에 포함 |
| Apple 홈 화면 | `../icons/gachita-180.png` | 180×180 |
| 웹 앱 설치 | `../icons/gachita-192.png`, `../icons/gachita-512.png` | 192×192, 512×512 |
| 링크 미리보기 | `gachita-social.png` | 1200×630 |
| Android 기본 launcher | `../../car/app/src/main/res/mipmap-*/ic_launcher*.png` | 48·72·96·144·192 |
| Android adaptive launcher | `../../car/app/src/main/res/drawable-nodpi/gachita_launcher_art.png` | 512×512 |

PNG 파생본은 macOS `sips -z 높이 너비 원본 --out 대상`으로 만들었습니다. SVG favicon은 이미지 문맥에서 외부 파일을 읽지 않아도 표시되도록 192 PNG를 내부에 포함합니다. `gachita-social.svg`는 같은 원본의 512 PNG와 이름·소개 문구를 배치한 편집 원본입니다. 브라우저 SVG 이미지 렌더러를 사용해 1200×630 Canvas로 내보냈으며, 새 캐릭터 그림을 생성하거나 그리지 않았습니다.

웹의 maskable 아이콘은 중심에서 반지름 40%인 안전 영역을 기준으로 확인합니다. 원본에서 검은 윤곽의 최대 반지름은 이미지 폭의 37.10%입니다. Android는 108dp 레이어의 중앙 66dp 안전 영역에 맞춰 foreground 각 변에 12% 여백을 적용합니다. 여백 적용 뒤 윤곽 반지름은 28.20%로, 안전 반지름 30.56% 안에 들어갑니다. 원형과 둥근 사각형으로 자른 브라우저 미리보기에서도 팔과 발을 확인했습니다. 이 검수는 자산과 마스크 검수이며, 기기에 설치한 launcher의 검수와 구분합니다.

안전 영역 기준은 [Web App Manifest](https://www.w3.org/TR/appmanifest/#icon-masks)와 [Android adaptive icon 문서](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)를 따릅니다. 마스터 원본의 바깥 그림자는 핵심 윤곽 측정에서 제외했습니다.

`mascot.svg`는 최종 시안(민준 개선안)의 가치타 본체 마스코트 `Mascot`(Figma 노드 `7:544`, 상태=기록 중) 24×24 선 그림입니다. 폰 머리 줄(app bar)에 씁니다. Figma MCP의 에셋 주소에서 받은 SVG에서 표시용 속성(`style`, `preserveAspectRatio`)과 레이어 id만 지웠고 경로는 그대로입니다. 대표 캐릭터(앱 아이콘)와 다른 실루엣입니다.

## 첫 화면(P01) 보관함 카드 그림

`welcome-dad.png`·`welcome-seojun.png`(192×192)는 최신 시안 P01(`eZ2xsOXkrszqdP489kduCs` 2073:3697 'Archive / 캐릭터 / 아빠·서준')의 그림을 그대로 받은 것입니다. 기본 캐릭터(`../chars/`)와 자르기·바탕이 달라 따로 둡니다.
