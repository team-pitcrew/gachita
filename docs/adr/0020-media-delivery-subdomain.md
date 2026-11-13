# ADR-0020: 클립 영상은 media 하위 도메인에서 API가 흘려보낸다

* **상태:** 채택됨, 2026-11-14 — 길(`media` 하위 도메인, Cloudflare 프록시 끔, 11/13)과 영상 전용 ALB(11/14)를 지환님이 정함
* **관련:** T64(#118), T63(#117), T43, T27(#33), [ADR-0013](0013-network-edge-and-isolation.md) 7절, [ADR-0014](0014-transcript-storage.md) 5절, [ADR-0015](0015-split-nodes-private-subnets-alb.md), [ADR-0017](0017-alb-by-controller-and-fold-order.md)

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

### 5. 저장

클립은 S3 클립 전용 버킷(서울, `gachita-<env>-clips-<계정>`)에 둔다. 버전 관리를 켜지 않아 지우면 바로 사라진다(남는 버전 없음). 객체는 2일 뒤 만료된다(T64 #118, ADR-0014 5절).

## 결과

- ADR-0013 7절의 '클립·사진' 줄과 ADR-0014 5절은 이 문서를 가리킨다. 클립을 **올리는** 길은 ADR-0007과 `voice.md`대로 차량 앱 → API(`Authorization` 머리말, #117)이고, ADR-0014 5절의 '서명 주소로 직접 올림'도 이에 맞춰 고친다.
- 크기 어림: 여행 하나에 고른 장면 클립 약 2 MB(장면 10개, 2.4~3.9초에 150~250 KB, 11/13 실측), 숏폼 30~45초 세로본 약 1 MB(시연용 세로본 44초 1.2 MB). 보는 사람이 가족 몇 명이라 노드 한 대로 흘려보내도 부담이 작다(재지 않음).
- 할 일
  - 인프라(T64 또는 T27): 레코드·SLO가 ALB를 이름으로 찾게 바꾸기(먼저), Gateway `media`와 HTTPRoute, 기존 HTTPRoute에서 `/media/` 빼기, `media` 이름의 인증서(따로)와 검증 레코드, Cloudflare 레코드(DNS만), API의 서비스 계정 역할(클립 버킷의 읽기·쓰기·지우기, 버전 권한 없음)과 네트워크 정책(그 버킷 주소와 서울 STS로 나감) — 이 둘은 T64에서 함, 접기·펴기 순서. 권한 경계는 이미 `gachita-*` 이름으로 두 번째 ALB를 덮는다.
  - API(백엔드 · 비즈니스 로직, T43과 맞춤): `/media/` 경로의 권한 확인과 흘려보내기, 호스트·원래 경로 확인, 쿠키 발급, 참가자·주소별 요청 수 제한.
- 잃는 것: `media` 이름에는 Cloudflare의 WAF와 요청 수 제한이 없다(AWS Shield Standard만). `/media/` 밖의 API 경로는 ALB 규칙과 API의 호스트·원래 경로 확인으로 막고, 확실히 기대는 것은 API 쪽이다(인코딩한 경로를 ALB가 어떻게 다루는지는 재지 않음).
- 확인하지 못한 것: 실제로 펴서 본 적이 없다(선언 전). 쿠키 방식의 웹앱 인증, 차량 플레이어의 머리말, 범위 요청 처리 성능, ALB 둘이 같은 노드를 대상으로 삼을 때의 컨트롤러 동작.
