# ADR-0020: 클립 영상은 media 하위 도메인에서 API가 흘려보낸다

* **상태:** 제안, 2026-11-13 — 길(`media` 하위 도메인, Cloudflare 프록시 끔)은 지환님이 정함. 2절의 '영상 전용 ALB'는 비용 확인 대기
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
| R2에 두고 Worker가 같은 이름의 경로로 내보냄 | 주소 하나. 약관상 R2에 둔 것은 CDN으로 내보내도 됨. 내려받는 비용 없음 | 아이 목소리가 든 클립이 서울 밖에 놓일 수 있어 국외 이전 검토가 다시 붙음(#117). 저장소가 S3와 R2 둘 |
| **`media` 하위 도메인(DNS만) → ALB → API가 S3에서 흘려보냄** | 클립이 S3 서울에 그대로. 만료·회수·URL 토큰 문제가 없음. Cloudflare를 지나지 않아 약관과 무관 | 이 이름에는 Cloudflare의 WAF·요청 수 제한·DDoS 보호가 없음. ALB에 이 이름의 인증서가 필요 |
| CloudFront | AWS 안에서 끝남 | ADR-0010에서 뺌 |

## 결정

### 1. 주소

영상과 클립만 `https://media.gachita.mangowhois.ai/media/…`로 내준다. Cloudflare의 `media.gachita` 레코드는 프록시를 끄고(DNS만) ALB를 가리킨다. 웹앱, API, 정적 파일은 지금처럼 `gachita.mangowhois.ai`(프록시)에 둔다.

### 2. 들어오는 길: 영상 전용 ALB

기존 ALB(`gachita-dev`)는 그대로 Cloudflare 대역에서 오는 443만 받는다(ADR-0017, `sourceRanges`). 영상에는 **ALB를 하나 더 둔다**(Gateway `media`, 이름 고정 `gachita-dev-media`). 이 ALB는 443을 모든 곳에서 받고, 호스트 `media.gachita.mangowhois.ai`의 `/media/` 경로만 API로 보내며 나머지는 ALB가 404로 끝낸다.

- 같은 ALB를 모든 곳에 열지 않는 이유: 보안 그룹은 ALB 단위라, 열면 `gachita.mangowhois.ai`도 호스트 이름만 맞추면 Cloudflare를 거치지 않고 닿는다(WAF와 요청 수 제한을 우회). Cloudflare가 붙이는 비밀 머리말로 가르는 방법은 그 값이 Git의 HTTPRoute에 들어가야 해서 쓰지 않는다.
- 비용: 기존 ALB와 같은 크기다(ADR-0015의 어림, 상시로 켜 두면 월 약 $30). 접는 묶음이라 펴 있는 동안만 난다. **이 비용이 부담이면** 영상을 2차 발표 동안만 펴거나, 같은 ALB를 열고 위의 우회를 받아들이는 쪽으로 다시 정한다.
- 접는 순서(ADR-0017 3절)에 이 Gateway도 같이 들어간다. 컨트롤러가 ALB와 보안 그룹을 지운 뒤에 Terraform이 지운다.

### 3. 인증서와 레코드

- ACM 인증서에 `media.gachita.mangowhois.ai`를 더한다(남는 묶음, DNS 검증 레코드 하나 더). 컨트롤러가 리스너의 호스트 이름으로 찾는다.
- `media.gachita` 레코드(DNS만)는 기존 `gachita` 레코드처럼 접는 묶음에 두고, 펴기의 레코드 단계(ADR-0017 펴기 8번)가 ALB 주소로 고친다.

### 4. API가 하는 일

- 요청마다 권한을 확인한다(그 여행의 참가자, 또는 서버에 남은 공유 기록). 공유의 만료와 회수는 이 기록으로 하고, 주소에는 만료가 없다.
- **URL에 토큰을 넣지 않는다.** 차량 앱은 플레이어 요청의 `Authorization` 머리말로, 폰의 `<video>`는 머리말을 붙일 수 없어 쿠키(`Domain=gachita.mangowhois.ai`, `HttpOnly`, `Secure`, `SameSite=Lax`)로 인증한다. `media.gachita.mangowhois.ai`는 같은 사이트라 쿠키가 실린다. 쿠키 발급은 지금 API에 없는 방식이라 API 담당과 정한다.
- S3에서 읽어 흘려보내고, 범위 요청(`Range`)을 그대로 전한다. 응답은 `Cache-Control: private, no-store`. 서명한 S3 주소를 클라이언트에 주지 않는다.
- 이 길에는 Cloudflare의 요청 수 제한이 없으므로 API가 참가자마다 제한한다.

### 5. 저장

클립과 영상은 S3 데이터 버킷(서울)에 둔다. 버전 관리와 '지우면 바로 사라짐'은 T64(#118)가 정한다.

## 결과

- ADR-0013 7절의 '클립·사진' 줄과 ADR-0014 5절의 내려받기 문장은 이 문서를 가리킨다. 클립을 **올리는** 길(차량 앱 → API, `Authorization` 머리말, #117)은 바뀌지 않는다.
- 크기 어림: 여행 하나에 고른 장면 클립 약 2 MB(장면 10개, 2.4~3.9초에 150~250 KB, 11/13 실측), 숏폼 30~45초 세로본 약 1 MB(시연용 세로본 44초 1.2 MB). 보는 사람이 가족 몇 명이라 노드 한 대로 흘려보내도 부담이 작다(재지 않음).
- 할 일
  - 인프라(T64 또는 T27): Gateway `media`와 HTTPRoute, ACM 인증서에 이름 추가, Cloudflare 레코드(DNS만), 권한 경계에서 두 번째 ALB가 태그 조건에 드는지 확인, 접기·펴기 순서.
  - API(백엔드 · 비즈니스 로직, T43과 맞춤): `/media/` 경로의 권한 확인과 흘려보내기, 쿠키 발급, 참가자별 요청 수 제한.
- 잃는 것: `media` 이름에는 Cloudflare의 WAF와 요청 수 제한이 없다(AWS Shield Standard만). 이 ALB로는 `/media/` 밖의 API 경로에 닿지 않는다.
- 확인하지 못한 것: 실제로 펴서 본 적이 없다(선언 전). 쿠키 방식의 웹앱 인증, 차량 플레이어의 머리말, 범위 요청 처리 성능, ALB 둘이 같은 노드를 대상으로 삼을 때의 컨트롤러 동작.
