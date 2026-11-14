# 콘텐츠 기록 지도 바탕

`gangneung.jpg`(1200×840)는 강릉 일대 OpenStreetMap 지도 그림입니다. 최종 시안 'Asset / 강릉 실제 지도 / OpenStreetMap'을 차 앱이 쓰는 그림(`frontend/car/…/content_map_gangneung.webp`, #457 브랜치)에서 그대로 가져와 서버가 아는 형식(JPEG, 품질 82)으로만 바꿨습니다. 실행 중에 타일 서버를 부르지 않습니다.

- 경위도 범위(메르카토르를 이 넓이에서 선형으로 봄, 차 `Contents.kt`와 같은 값): 서 128.7905 · 동 128.9785 · 북 37.8184 · 남 37.7138
- 화면은 틀(350×300)을 가운데 맞춰 채우고(cover) 좌표를 같은 비율로 옮깁니다(`contents.js` `osmProjector`). 기록 좌표의 절반 넘게 이 범위 밖이면 예전처럼 그린 지도를 씁니다.
- 출처: © OpenStreetMap contributors, 데이터는 [ODbL](https://opendatacommons.org/licenses/odbl/). 지도 위와 첫 화면 아래에 밝힙니다.
