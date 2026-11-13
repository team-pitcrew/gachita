# ADR-0020: 클립 영상은 media 하위 도메인에서 API가 흘려보낸다

* **상태:** 채택됨, 2026-11-14 — 길(`media` 하위 도메인, Cloudflare 프록시 끔, 11/13)과 영상 전용 ALB(11/14)를 지환님이 정함. 같은 날 보충(T43·T76): 숏폼은 영상 파일을 만들지 않고 구성 데이터로 내준다(6절). 이 길로 나가는 것은 원음 클립(WAV)이고, 저장은 클립 전용 버킷(5절)
* **관련:** T64(#118, #167), T63(#117), T43(#63), T76(#158), T27(#33), [ADR-0013](0013-network-edge-and-isolation.md) 7절, [ADR-0014](0014-transcript-storage.md) 5절, [ADR-0015](0015-split-nodes-private-subnets-alb.md), [ADR-0017](0017-alb-by-controller-and-fold-order.md)

## 배경

ADR-0013 7절과 ADR-0014 5절은 클립을 S3 데이터 버킷에 두고 **API가 짧게 서명한 S3 주소로 내려준다**고 정했다. 숏폼 영상(T43)까지 이 길로 내려주면 네 가지가 걸린다.

- **보는 도중에 만료된다.** 플레이어는 영상을 범위 요청(Range)으로 여러 번 나눠 받고, S3는 서명 주소의 만료를 요청을 받은 때마다 본다. 만료 뒤의 되감기·이어 보기·다시 받기는 실패한다([S3 문서](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url)).
- **실제 수명이 정한 값보다 짧을 수 있다.** API는 서비스 계정 역할의 임시 자격 증명으로 서명한다. 서명 주소는 정한 만료와 그 자격 증명의 만료 가운데 먼저 오는 쪽에 끝난다(같은 문서).
- **공유를 회수할 수 없다.** 서명 주소는 만료 전까지 누구나 여러 번 쓴다. 받는 사람이 늦게 열면 이미 만료돼 있고, 길게 주면 거둘 수 없다. 도착 후 화면 문서(`frontend/spec/after-trip.md`)는 공유의 만료와 회수를 요구한다.
- **URL에 토큰이 실린다.** 서명은 쿼리에 들어간다. Pleos 앱 보안 가이드의 '인증 토큰을 URL의 경로나 쿼리에 넣지 않는다'에 걸릴 수 있다(#117).

`gachita.mangowhois.ai`의 경로로 API가 흘려보내면 위 넷은 풀리지만, 그 이름은 Cloudflare 프록시를 지난다. Cloudflare의 CDN 약관은 Enterprise가 아니면 영상과 큰 파일을 CDN으로 내보낼 때 정해진 유료 서비스(Developer Platform, Images, Stream)를 쓰라고 하고, 어기면 CDN 접근을 제한할 수 있다고 한다. 캐시와 단순 통과를 가르지 않는다([Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/), 11/13 확인).

## 검토한 선택

| 선택 | 좋은 점 | 걸리는 점 |
|---|---|---|
| 서명한 S3 주소 그대로(ADR-0013 7절) | 서버가 영상을 나르지 않음 | 위의 넷 |
| `gachita.mangowhois.ai` 경로로 API가 흘려보냄 | 주소 하나 | Cloudflare CDN 약관 |
| R2에 두고 Worker가 같은 이름의 경로로 내보냄 | 주소 하나. 약관이 드는 Developer Platform에 R2가 들어감(Cloudflare가 2023년 약관을 바꾸며 R2 등에 둔 콘텐츠는 된다고 설명, [블로그](https://blog.cloudflare.com/updated-tos/)). 내려받는 비용 없음 | 아이 목소리가 든 클립이 서울 밖에 놓일 수 있어 국외 이전 검토가 다시 붙음(#117). 저장소가 S3와 R2 둘 |
| **`media` 하위 도메인(DNS만) → ALB → API가 S3에서 흘려보냄** | 클립이 S3 서울에 그대로. 주소에 만료가 없고 회수가 됨. 서명한 S3 주소(자격 증명)가 URL에 실리지 않음. Cloudflare를 지나지 않아 약관과 무관 | 이 이름에는 Cloudflare의 WAF·요청 수 제한·DDoS 보호가 없음. ALB에 이 이름의 인증서가 필요 |
| CloudFront | AWS 안에서 끝남 | ADR-0010에서 뺌 |

## 결정

### 1. 주소

영상과 클립만 `https://media.gachita.mangowhois.ai/media/…`로 내준다. Cloudflare의 `media.gachita` 레코드는 프록시를 끄고(DNS만) ALB를 가리킨다. 웹앱, API, 정적 파일은 지금처럼 `gachita.mangowhois.ai`(프록시)에 둔다.

### 2. 들어오는 길: 영상 전용 ALB

기존 ALB(`gachita-dev`)는 그대로 Cloudflare 대역에서 오는 443만 받는다(ADR-0017, `sourceRanges`). 영상에는 **ALB를 하나 더 둔다**(Gateway `media`, 이름 고정 `gachita-dev-media`). 이 ALB는 443을 모든 곳에서 받고, 호스트 `media.gachita.mangowhois.ai`의 `/media/` 경로만 API로 보내며 나머지는 ALB가 404로 끝낸다.

- **호스트와 경로를 함께 묶는다.** 기존 Gateway의 경로는 `/` 전체를 API로 보내므로(`apps/edge/gateway.yaml`), 그대로 두면 `gachita.mangowhois.ai/media/…`로도 영상이 Cloudflare를 지나 나간다. 기존 경로가 `/media/`를 API로 보내지 않게 한다(표준 HTTPRoute로는 `/`에서 접두사를 빼낼 수 없어, 컨트롤러의 고정 응답 같은 방법을 구현 때 확인). 실제로 막는 것은 API다: `/media/`는 `media` 호스트에서만, `media` 호스트에서는 `/media/`만 받는다. API의 경로 정리(`server.js`)는 `/media/%2e%2e/api/…`를 `/api/…`로 바꾸므로, 이 확인은 정리 전의 원래 경로로 한다.

- 같은 ALB를 모든 곳에 열지 않는 이유: 보안 그룹은 ALB 단위라, 열면 `gachita.mangowhois.ai`도 호스트 이름만 맞추면 Cloudflare를 거치지 않고 닿는다(WAF와 요청 수 제한을 우회). Cloudflare가 붙이는 비밀 머리말로 가르는 방법은 그 값이 Git의 HTTPRoute에 들어가야 해서 쓰지 않는다.
- 비용: 기존 ALB와 같은 크기다(ADR-0015의 어림, 상시로 켜 두면 월 약 $30). 펴 있는 동안만 난다. 지환님이 이 비용으로 정했다(11/14). 같은 ALB를 열어 우회를 받아들이는 안은 쓰지 않는다.
- 이 ALB도 기존 ALB처럼 **컨트롤러가 만들고 지운다**(ADR-0017 1절 표의 'ALB 쪽'). 접을 때는 접기 1번에서 Gateway `media`도 같이 지워, 컨트롤러가 ALB와 보안 그룹을 지운 뒤에 Terraform이 접는 묶음을 지운다.
- **이 이름에서는 `CF-Connecting-IP`를 믿지 않는다.** ADR-0015 4절은 Cloudflare만 들어온다는 전제로 그 머리말을 믿는데, `media`에는 누구나 바로 들어와 머리말을 꾸밀 수 있다. 이 길의 요청 주소는 ALB가 붙인 `X-Forwarded-For`의 마지막 값으로 본다.

### 3. 인증서와 레코드

- **인증서는 따로 하나 더 받는다**(남는 묶음, `persist/`에 `media.gachita.mangowhois.ai` 하나짜리 `aws_acm_certificate`와 검증 레코드). 기존 인증서(`persist/main.tf`, 이름 하나)에 이름을 더하면 인증서가 새로 만들어지고, 펴 있는 동안에는 리스너가 옛 인증서를 쓰고 있어 지우지 못한다. ADR-0017의 '인증서를 다시 받지 않음'과도 어긋난다. 컨트롤러는 리스너의 호스트 이름으로 각 인증서를 찾는다.
- `media.gachita` 레코드(DNS만)는 기존 `gachita` 레코드처럼 접는 묶음에 두고, 펴기의 레코드 단계(ADR-0017 펴기 8번)가 ALB 주소로 고친다. **지금 그 단계는 컨트롤러의 클러스터 태그로 ALB를 찾아 하나만 있다고 본다**(`edge.tf`의 `one()`, `slo.tf`도 같은 ALB를 씀). ALB가 둘이 되면 펴기 8번과 펴 있는 동안의 모든 plan이 실패하므로, 레코드와 SLO 지표가 ALB를 **이름**(`gachita-dev`, `gachita-dev-media`)으로 찾게 먼저 바꾼다.

### 4. API가 하는 일

- 요청마다 권한을 확인한다(그 여행의 참가자, 또는 서버에 남은 공유 기록). 공유의 만료와 회수는 이 기록으로 하고, 주소에는 만료가 없다. 공유 링크에는 공유 코드가 URL에 실리지만, 그 코드의 만료와 회수는 서버가 정한다(서명한 S3 주소처럼 만료 전까지 막을 수 없는 자격 증명이 아님).
- **인증 토큰을 URL에 넣지 않는다.** 차량 앱은 플레이어 요청의 `Authorization` 머리말로, 폰의 `<video>`는 머리말을 붙일 수 없어 쿠키(`Domain=gachita.mangowhois.ai`, `Path=/media/`, `HttpOnly`, `Secure`, `SameSite=Lax`)로 인증하고, API는 그 쿠키를 `/media/`에서만 받는다. `media.gachita.mangowhois.ai`는 같은 사이트라 쿠키가 실린다. `<video src>`만 쓰면 CORS가 필요 없고, `fetch`·MSE·자막(`<track>`)으로 받으면 자격 증명을 허용하는 CORS(웹앱 이름 하나만)를 더한다. 쿠키 발급은 지금 API에 없는 방식이라 API 담당과 정한다.
- S3에서 읽어 흘려보내고, 범위 요청(`Range`)을 그대로 전한다. 응답은 `Cache-Control: private, no-store`. 서명한 S3 주소를 클라이언트에 주지 않는다.
- 이 길에는 Cloudflare의 요청 수 제한이 없으므로 API가 제한한다: 인증된 요청은 참가자마다, 인증 전 요청은 요청 주소(`X-Forwarded-For`의 마지막 값)마다. API 파드가 둘이라(`deployment.yaml`) 파드마다 따로 세므로 실제 한도는 그 두 배다.

API의 구현(T76, `backend/api/server.js`의 `clipMedia`·`mediaCookie`):
- 경로는 `GET /media/trips/{code}/recordings/{id}`(클립 id = 장면 id). 권한은 기록본과 같다(그 여행의 녹음에 동의한 참가자).
- 쿠키는 웹앱이 `gachita.mangowhois.ai`에서 참가자 토큰 머리말로 `POST /api/trips/{code}/media-cookie`를 불러 받는다. 값은 그 참가자 토큰이고 `Path=/media/trips/{code}/`(위 1절의 `/media/`보다 좁게 — 여행마다 따로), `Max-Age`는 여행이 닫힐 때(만든 뒤 48시간)까지, `Domain`은 media 주소의 부모 이름(`gachita.mangowhois.ai`, 설정에서 정하고 요청의 Host를 쓰지 않음; 로컬 주소면 붙이지 않음). 이 토큰은 올리기·지우기·동의 켜기에도 쓰이는 자격이지만, 같은 토큰이 웹앱 저장소에 이미 있어 늘어나는 노출은 없고 HttpOnly라 페이지 스크립트가 읽지 못한다(듣기 전용 토큰은 따로 두지 않음). `<audio src>`만 쓰므로 CORS는 두지 않았다.
- 범위 요청은 `bytes=시작-끝` 하나만 S3에 그대로 넘겨 `206`, 그 밖의 모양은 전체를 준다. 벗어나면 `416`.
- 요청 수 제한은 파드마다 메모리에서 1분 창: 요청 주소마다 600(인증 전, IPv6는 /64), 참가자마다 300. 넘으면 `429`(`rate_limited`)와 `Retry-After`. 요청 주소는 `X-Forwarded-For`의 마지막 값이라 ALB의 XFF 처리 방식이 기본값(append)이어야 맞다.
- 원래 경로와 정리된 경로가 `/media/`에서 어긋나면 Host와 상관없이 404(Host는 클라이언트가 정하므로 이름만 믿지 않는다). 토큰이 없으면 DB에 가기 전에, 없는 여행이면 틀린 토큰과 같은 401.
- 받은 바이트를 모아 보낸다(클립은 5 MB까지) — '흘려보냄'은 그 뜻이다.
- 주소는 `MEDIA_BASE_URL`(기본 `https://media.gachita.mangowhois.ai`). 로컬·CI는 localhost에서 `/api`와 `/media`를 함께 받는다.

### 5. 저장

클립은 **클립 전용 S3 버킷**(`CLIPS_BUCKET`, 서울, 버전 관리 끔, SSE-S3, 공개 차단)에 둔다. 버킷과 API 서비스 계정 역할(그 버킷의 Put·Get·DeleteObject와 ListBucket)은 T64(#118, #167)가 만든다. 데이터 버킷은 버전 관리가 켜져 있어 지워도 옛 버전이 30일 남으므로(11/13 실측) 쓰지 않는다.

- **지우기는 API가 직접 한다**(T76): 사람의 지우기는 바로, 녹음 동의 철회와 여행 48시간은 같은 트랜잭션에서 지울 키를 적고 커밋 뒤에 버킷에서 지운다(실패하면 10분마다 다시). 버전 관리를 끈 버킷이라 지운 뒤 남는 버전이 없다.
- **수명 규칙은 뒷받침이다**: 올린 뒤 2일을 다음 UTC 자정으로 올려 만료하고 S3의 지우기가 비동기라, API가 놓친 객체(올리다 서버가 죽음 등)는 최대 약 3일 남을 수 있다.

### 6. 숏폼은 영상 파일 없이 구성 데이터로 (11/14 보충, T43)

영상 파일을 만들지 않는다. 렌더링 서버도 외부 영상 업체(Higgsfield 등: 기본 약관상 학습 사용, 국외 이전, 18세 이상 — #117 조사)도 쓰지 않고, 차와 웹이 원음 클립 위에 자막과 캐릭터를 그 자리에서 그린다.

- **장면 후보**(`GET /api/trips/{code}/scene-suggestions`, LLM 없음 — Claude API 계약 전): 각 발화에서 시작하는 30초 창의 발화 수 + 2 × (말한 사람 수 − 1). 말한 사람은 좌석 구역으로 세고(구역을 모르면 화자 대조로 붙은 프로필), 발화 4개 미만은 뺀다. 사람이 이미 남긴 장면의 구간과 겹치는 창은 빼고, 점수 순으로 서로 겹치지 않게 최대 5개를 시각 순으로 준다. 구간은 첫 발화 1초 전 ~ 마지막 발화 4초 뒤(15~35초). 사람이 고르면 `POST /moments`에 `at`·`from`·`to`를 남기고 차가 그 구간을 잘라 올린다(T63 → T76). 규칙은 `backend/api/scenes.js` 한 파일이다.
- **숏폼 구성**(`GET /api/trips/{code}/shortform`): 클립이 올라온 장면마다 소리 주소(이 문서의 `/media/` 절대 주소), 클립 첫 표본의 시각, 자막 큐(클립 안의 초, 글, 화자 대조로 붙은 참가자, 좌석 구역), 출연(이름, 캐릭터, 자리). 자막의 끝은 글자 수로 어림한다(발화에 끝 시각이 없음).
- **보여 주는 곳**: 웹은 9:16 재생 페이지(`<audio>` + 자막·캐릭터), 차는 주차 화면에서 같은 데이터로 그 자리 재생. 차로 따로 만들어 보낼 완성본이 없다.
- **비용**: 후보·구성 계산은 서버 CPU만($0, LLM·렌더링 없음). 저장은 클립 크기만큼(아래).
- **잃는 것**: 숏폼을 파일로 내려받거나 SNS에 올리는 기능, 캐릭터 입모양. 밀도 규칙은 이야기의 '재미'를 직접 보지 않는다(LLM 계약이 생기면 이 창들을 후보로 넘겨 이유를 쓰게 한다). 파일 공유가 필요해지면 렌더링을 다시 본다 — 그때도 내보내는 길은 이 문서의 `media` 주소다.

## 결과

- ADR-0013 7절의 '클립·사진' 줄과 ADR-0014 5절은 이 문서를 가리킨다. 클립을 **올리는** 길은 ADR-0007과 `voice.md`대로 차량 앱 → API(`Authorization` 머리말, #117)이고, ADR-0014 5절의 '서명 주소로 직접 올림'도 이에 맞춰 고친다.
- 크기 어림: 클립은 16 kHz·16비트·모노 WAV라 초당 32 KB다. 장면 구간 15~35초면 클립 하나에 약 0.5~1.1 MB, 장면 10개면 약 5~11 MB, 올리기 상한은 5 MB(약 156초). 문장 하나짜리 클립(2.4~3.9초)은 11/13 실측 150~250 KB(2채널). 보는 사람이 가족 몇 명이라 노드 한 대로 흘려보내도 부담이 작다(재지 않음).
- 할 일
  - 인프라(T64 또는 T27): 레코드·SLO가 ALB를 이름으로 찾게 바꾸기(먼저), Gateway `media`와 HTTPRoute, 기존 HTTPRoute에서 `/media/` 빼기, `media` 이름의 인증서(따로)와 검증 레코드, Cloudflare 레코드(DNS만), 클립 전용 버킷과 API의 서비스 계정 역할(5절)과 네트워크 정책(그 버킷과 STS로 나감 — 지금 API는 구글로만 나감), 접기·펴기 순서. 권한 경계는 이미 `gachita-*` 이름으로 두 번째 ALB를 덮는다.
  - API(백엔드 · 비즈니스 로직): `/media/` 경로의 권한 확인과 흘려보내기, 호스트·원래 경로 확인, 쿠키 발급, 참가자·주소별 요청 수 제한 — T76(#163)에서 함. 장면 후보와 숏폼 구성 — T43에서 함.
  - 웹(9:16 재생 페이지)과 차(그 자리 재생)는 6절의 데이터로 그린다.
- 잃는 것: `media` 이름에는 Cloudflare의 WAF와 요청 수 제한이 없다(AWS Shield Standard만). `/media/` 밖의 API 경로는 ALB 규칙과 API의 호스트·원래 경로 확인으로 막고, 확실히 기대는 것은 API 쪽이다(인코딩한 경로를 ALB가 어떻게 다루는지는 재지 않음).
- 확인하지 못한 것: 실제로 펴서 본 적이 없다(선언 전). 쿠키 방식의 웹앱 인증, 차량 플레이어의 머리말, 범위 요청 처리 성능, ALB 둘이 같은 노드를 대상으로 삼을 때의 컨트롤러 동작.
