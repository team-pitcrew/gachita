# ADR-0026: 미디어는 CloudFront가 S3에서 읽어 서명한 요청에만 내준다

* **상태:** 제안됨, 2026-11-16 — 방향은 지환님 지시(11/16: CDN과 S3로 속도를 높인다, 쇼츠와 프로필 이미지, 접근은 키로, 통상적인 방법). 자원은 아직 만들지 않았다(적용은 지환님 승인 뒤)
* **대체:** [ADR-0010](0010-domain-and-cloudflare-edge.md)과 [ADR-0013](0013-network-edge-and-isolation.md) 7절의 'CloudFront는 만들지 않는다'(미디어 경로에 한해), [ADR-0020](0020-media-delivery-subdomain.md)의 'media 하위 도메인 → 영상 전용 ALB → API가 흘려보냄'. 웹앱·API·정적 파일의 길(Cloudflare → ALB)은 그대로다
* **관련:** T179(#614), [ADR-0011](0011-aws-credentials-via-oidc.md), [ADR-0014](0014-transcript-storage.md) 5절, [ADR-0025](0025-shorts-generation-worker-codex-skill.md), #601(Cloudflare 프록시 끄기, 별개)

## 배경

쇼츠(4~5 MB mp4), 표지(1 MB png), 프로필 사진은 API가 권한을 확인한 뒤 본문을 흘려보낸다. 11/16에 잰 값으로 `gachita.mangowhois.ai`의 모든 요청은 첫 바이트가 0.95~1.09초이고(1 KB짜리 `/`도 0.95초), Cloudflare 거점이 미국 서부(PDX·SEA)로 잡힌다. 큰 파일일수록 이 왕복이 길어진다(11/15: 3.5 MB 영상 43~130초).

ADR-0020은 같은 문제를 '영상 전용 ALB'로 풀려 했으나 영상 파일이 없어져 대체됐다. 지금은 서버가 만든 쇼츠 영상이 다시 있고(ADR-0025), ADR-0020이 서명한 S3 주소에서 든 네 가지 걸림은 아래처럼 풀린다.

| ADR-0020의 걸림 | 이번 구성에서 |
|---|---|
| 보는 도중에 만료 | CloudFront는 서명의 만료를 요청을 받을 때 본다. 만료를 재생 시간보다 넉넉히 주고(API가 정함), 폰 웹은 받은 것을 blob으로 쓴다 |
| 실제 수명이 자격 증명에 묶임 | 서명 키가 역할의 임시 자격 증명이 아니라 따로 둔 RSA 키라 정한 만료 그대로다 |
| 공유를 회수할 수 없음 | 서명의 만료를 짧게 주고, 가장자리 캐시를 10분으로 묶는다. 만료 전의 주소는 막지 못한다(남는 위험) |
| URL에 토큰 | 폰 웹은 서명 주소, 차량 앱은 같은 서명을 Cookie 머리말로 보낸다(Pleos 앱의 '토큰을 URL에 넣지 않는다'는 차에서 지킴) |

## 결정

### 1. 길

`https://media.gachita.mangowhois.ai/<키>` → CloudFront 배포 하나 → OAC(sigv4) → 클립 버킷. Cloudflare의 `media.gachita` 레코드는 DNS만이다(프록시 안 함). 그래서 Cloudflare의 영상·큰 파일 약관과 무관하다(ADR-0020의 판단 그대로).

- 가격 등급은 `PriceClass_200`: 서울 거점이 드는 가장 낮은 등급이다(100은 북미·유럽만).
- 인증서는 us-east-1의 ACM(CloudFront의 조건), 검증은 서비스 인증서와 같이 Cloudflare DNS 레코드.
- 버킷은 계속 비공개다(공개 차단 넷 그대로, SSE AES256이라 KMS 권한이 필요 없다). 버킷 정책은 **이 배포만, 접두사 셋(`shorts/`·`profiles/`·`public/`)만** 읽게 한다. 같은 버킷의 원음 클립(여행 코드 아래)과 `short-assets/`는 서명이 있어도 CDN으로 나가지 않는다.

### 2. 접근은 키로

- 기본 동작은 서명 필수다(trusted key group, RSA 2048 공개 키 하나). 서명이 없거나 만료된 요청은 CloudFront가 403으로 끝낸다.
- 서명은 API가 지금의 권한 확인 뒤에 한다. API가 받는 값은 셋이다.

| 값 | 무엇 | 가는 길 |
|---|---|---|
| `MEDIA_CDN_BASE` | `https://media.gachita.mangowhois.ai` | Terraform → SSM `/gachita/dev/tf/media/` |
| `MEDIA_KEY_PAIR_ID` | CloudFront 공개 키 번호 | 위와 같음 |
| `MEDIA_PRIVATE_KEY` | 서명 개인키(PEM) | 사람이 `gh secret set` → infra-secrets → SSM `/gachita/dev/app/media/` |

- 개인키는 저장소와 Terraform 상태에 없다. 공개 키는 비밀이 아니어서 저장소 변수 `MEDIA_PUBLIC_KEY`로 Terraform에 준다. 이 변수가 비면 남는 묶음은 CDN을 만들지 않는다.
- 키를 바꿀 때는 새 공개 키를 키 묶음에 더해 둘 다 받게 한 뒤 옛 것을 뺀다.
- `/public/*`만 서명 없이 내주고 길게 캐시한다(캐릭터 같은 공개 정적 그림).

### 3. 캐시와 지움

- 비공개 객체는 가장자리에 길어야 10분 둔다. 동의 철회·삭제로 S3에서 지운 것은 그 안에 CDN에서도 사라진다.
- **무효화(CreateInvalidation)는 API가 부르지 않는다.** 부르려면 API 역할과 권한 경계에 CloudFront 권한을, 네트워크 정책에 CloudFront API로 나가는 길을 더해야 한다. 10분 캐시와 짧은 서명 만료로 충분하다고 본다. 급하면 사람이 배포 번호(`media_distribution_id`)로 부른다(달에 1,000경로까지 무료).
- 프로필 사진은 키에 내용 해시를 넣어(`profiles/{profileId}/photo/{해시}.{확장자}`) 바꾸면 주소가 바뀐다.

### 4. CORS

웹앱이 fetch와 canvas로 읽으므로 응답 머리말 정책으로 가장자리에서 붙인다. 허용 출처는 `https://gachita.mangowhois.ai` 하나, 자격 증명 없음, GET·HEAD만. 서명 주소로 하는 단순 GET은 사전 요청(OPTIONS)이 없다. 웹이 머리말을 더 붙여 사전 요청이 생기면 OPTIONS를 열어야 한다.

### 5. 어디에 두나

남는 묶음(`persist/media.tf`)에 둔다. 켜 둔 시간으로 돈이 나가지 않고, 만들고 지우는 데 10분쯤 걸리며, 주소와 서명 키가 접었다 펴도 같아야 한다. 접힌 동안에는 서명해 줄 API가 없어 비공개 미디어는 열리지 않는다.

배포 역할에는 CloudFront 권한이 없었다. `account/policies.tf`에 더한다(사람이 로컬에서 적용).

- 계획 역할: `cloudfront:Get*`·`List*`(설정과 공개 키뿐).
- 적용 역할: 배포는 우리 태그로 만들고 우리 태그가 있는 것만 고친다. 원본 접근 제어, 캐시·응답 머리말 정책, 공개 키, 키 묶음은 태그가 없고 ARN이 번호라 좁히지 못한다. 태그를 달며 만드는 데 필요한 `TagResource`도 요청 태그 조건으로 준다. 그래서 같은 계정의 남의 CloudFront 자원을 고칠 수 있는 틈이 있다. 이 계정에는 다른 CloudFront 자원이 없다(11/16, 배포·OAC·공개 키·키 묶음·사용자 정책 모두 0). us-east-1의 인증서는 기존 ACM 문장(리전 조건 없음, 우리 태그)으로 된다.
- API 역할은 이미 클립 버킷 전체를 읽고 쓰고 지운다(`iam.tf`). 새 접두사에 더할 권한은 없다.

## 비용 어림

[CloudFront 종량 요금표](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/)(11/16 확인)로 본다.

| 항목 | 요금 | 이 서비스에서 |
|---|---|---|
| 내보내는 양 | 달 1 TB까지 무료(기한 없는 무료 구간), 그 뒤 한국 구간 GB당 $0.120 | 5 MB 쇼츠 한 편을 100번 보면 0.5 GB. 시연 규모로는 무료 구간의 1%에도 못 미침 |
| 요청 수 | 달 1,000만 건까지 무료, 그 뒤 HTTPS 1만 건당 $0.0120 | 무료 구간 안 |
| S3 → CloudFront | 무료 | - |
| 인증서(ACM, SNI) | 무료 | - |
| 무효화 | 달 1,000경로까지 무료, 그 뒤 경로당 $0.005 | 부르지 않음 |
| 서명 키, OAC, 정책 | 따로 요금 없음(요금표에 항목 없음) | - |

달 $0으로 어림한다(무료 구간 안). 구간을 넘기면 내보낸 양만큼만 낸다(예: 달 100 GB를 더 내보내면 $12). S3 보관·요청 요금은 지금도 내는 값이라 달라지지 않는다. 정액 요금제(Free $0, Pro 달 $15 등)는 쓰지 않는다.

## 결과

- 얻는 것: 미디어가 서울 거점에서 나간다. API 파드가 큰 본문을 나르지 않는다.
- 잃는 것: 서명 주소는 만료 전까지 가진 사람 누구나 쓴다(공유 회수가 즉시가 아님, 캐시까지 최대 10분). `media` 이름에는 Cloudflare의 WAF·요청 수 제한이 없고 AWS Shield Standard만 있다. 서명 없는 요청은 원본에 닿지 않아 비용 공격의 폭은 `/public/*`과 403 응답의 요청 수로 좁다.
- 할 일
  - 인프라(이 PR): `persist/media.tf`, `account/policies.tf`, 워크플로의 공개 키 변수와 개인키 길.
  - 인프라(적용 뒤): API 배포에 값 셋을 잇는 Secret(`apps/api`), 확인 넷(`x-amz-cf-pop`이 ICN 계열, 서명 없는 요청 403, 두 번째 요청 캐시 HIT, 같은 파일의 첫 바이트 시간 전후).
  - API(백엔드 · 비즈니스 로직): 서명(주소와 Cookie), 프로필 사진을 Postgres에서 S3로 옮기기, 웹·차량 앱이 CDN 주소로 받기.
- 확인하지 못한 것: 실제로 만들어 본 적이 없다(계획만, 11/16 `Plan: 13 to add`). 차량 앱이 Cookie 머리말로 받는 길, 웹의 fetch가 사전 요청 없이 되는지, 한국 통신망에서 실제로 잡히는 거점.
