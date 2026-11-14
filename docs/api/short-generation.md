# 힉스필드 쇼츠 생성 API

녹음 클립과 전사가 준비되면 두 캐릭터의 반응 영상을 힉스필드에서 생성하고, 서버가 원음과 한국어 자막을 합쳐 MP4로 저장합니다. 앱은 제작 계획을 먼저 보여 주고 외부 생성에 사용할 자료를 확인받은 뒤 작업을 시작합니다. 기존 `/shortform`은 원음·자막 구성 조회로 유지합니다. 숏폼의 세 가지 형태(구성 재생, 기기에서 만드는 영상, 이 서버 생성), 이 생성을 꺼서 배포하는 결정과 남은 위험은 [ADR-0022](../adr/0022-shortform-video-on-device-and-server-generation-off.md)에 있습니다.

## 템플릿과 제작 설정

| 템플릿 | 장면과 연출 |
|---|---|
| `car-sitcom-v1` | 차 안 두 캐릭터, 큰 표정과 잠깐 늦는 반응, 첫 장면에서 바로 대화 시작 |
| `travel-postcard-v1` | 같은 캐릭터와 원음에 창밖 풍경·종이 질감·절제한 움직임을 더한 여행 엽서 |

Seedance 2.5 `bytedance/seedance-2.5/reference-to-video`, 9:16, 720p, MP4를 사용합니다. 15~45초 장면을 약 5~8초 단위로 나눕니다. 두 캐릭터의 참조 이미지를 각 요청에 넣고, 온전한 실루엣과 정확히 두 팔을 지시합니다. 자막은 생성 모델에 그리게 하지 않고 마지막에 Noto Sans CJK KR로 합성합니다. 최종 소리는 녹음 클립을 AAC로 변환한 소리입니다. 모델이 만든 소리는 사용하지 않습니다.

`audioReference:false`가 기본값이며 캐릭터 이미지·발화 시각·반응 지시만 외부에 보냅니다. `true`이면 해당 장면 원음 조각도 보내 발화 움직임의 참고로 씁니다. 대화 원문과 참가자 실명은 프롬프트에 넣지 않습니다. 화자 대조가 없으면 실명을 추측하거나 특정 캐릭터가 말한 것으로 지정하지 않습니다. 두 캐릭터가 표정으로 반응하며 자막에는 ‘화자 미확인’을 표시합니다. 자동 추천은 준비된 클립 중 자막 수가 많은 장면을 고르는 규칙이며 웃음 검출·LLM 평가·정밀 립싱크를 뜻하지 않습니다.

## 호출 순서

참가자 토큰을 `Authorization: Bearer <participant-token>`으로 보냅니다. 모든 동승자가 녹음에 동의해야 합니다. 키와 공급자 응답 URL은 앱에 보내지 않습니다.

1. `GET /api/short-templates`: 템플릿 목록과 `enabled`를 받습니다.
2. `POST /api/trips/{code}/short-plans`: `{ "templateId":"car-sitcom-v1", "audioReference":false }`를 보냅니다. `momentId`를 생략하면 준비된 장면을 추천합니다. 응답의 `momentId`, `generation`, `planHash`, `externalData`, 길이·캐릭터·자막·촬영 단위를 표시합니다.
3. `POST /api/trips/{code}/short-generations`: 아래 요청으로 제작을 시작합니다. 202를 받으며, 같은 키·내용을 다시 보내면 기존 작업을 200으로 받습니다.
4. `GET /api/trips/{code}/short-generations/{id}`로 상태를 조회합니다. 전체 목록은 같은 경로에서 `{id}`를 뺍니다.
5. 완료 응답의 `result.url`을 같은 참가자 인증으로 받아 MP4를 저장하거나 시스템 공유 창으로 전달합니다.
6. `DELETE /api/trips/{code}/short-generations/{id}`는 만든 사람이 취소하거나 삭제합니다. 200 이후 파일 접근이 즉시 막히며 공급자·S3 정리는 비동기로 이어집니다.

```json
{
  "momentId": "제작 계획의 momentId",
  "templateId": "car-sitcom-v1",
  "audioReference": false,
  "generation": 1,
  "planHash": "제작 계획의 planHash",
  "externalGenerationConsent": true,
  "idempotencyKey": "client-request-unique-id"
}
```

같은 요청을 다시 보낼 때 `idempotencyKey`를 유지합니다. 키는 8~100자 영문·숫자·밑줄·하이픈입니다. 주행 중 제작 시작은 409입니다. 자막·원음·화자·캐릭터가 바뀌면 계획을 다시 받아야 합니다. 동의가 철회되거나 보관 기간이 끝나면 기존 작업과 결과를 사용할 수 없습니다.

| 상태 | 의미 |
|---|---|
| `queued` | 서버가 작업을 저장했습니다. |
| `submitting` | 유료 요청을 제출하고 있습니다. |
| `generating` | 장면을 생성하거나 결과를 받고 있습니다. |
| `composing` | 생성 장면과 원음·자막을 합치고 있습니다. |
| `completed` | 인증된 결과 파일을 받을 수 있습니다. |
| `failed` | 생성·합성이 실패했습니다. `errorCode`로 원인을 구분합니다. |
| `canceled` | 삭제·철회·자료 변경·보관 만료로 사용할 수 없습니다. |
| `submission_unknown` | 요청이 접수됐는지 확인되지 않습니다. 자동 재제출하지 않습니다. |

## 서버 설정과 운영

| 환경 변수 | 값과 용도 |
|---|---|
| `SHORTS_ENABLED` | `true`일 때 새 작업을 받습니다. 기본은 꺼짐입니다. |
| `HF_CREDENTIALS` | 서버 전용 `KEY_ID:KEY_SECRET`. 또는 `HF_API_KEY_ID`와 `HF_API_KEY_SECRET`을 함께 씁니다. |
| `SHORTS_BUCKET` | 결과·참조 자료의 비공개 S3 버킷. 생략하면 `CLIPS_BUCKET`입니다. |
| `SHORTS_DAILY_SECONDS` | 하루 전체 작업의 생성 초 합계 한도. 기본 120초이며 각 조각을 정수 초로 올림합니다. 취소·실패도 당일 한도에서 빼지 않습니다. |
| `HF_OUTPUT_HOSTS` | 공급자 결과를 받을 HTTPS CDN 호스트의 정확한 이름을 쉼표로 구분합니다. 리다이렉트·사설 주소·IP 리터럴은 거절합니다. 실제 공급자 결과의 호스트와 배포 네트워크 정책을 함께 확인합니다. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | 기본 명령은 `ffmpeg`, `ffprobe`입니다. 이미지에 ffmpeg·libass·한국어 글꼴이 포함됩니다. |

API 복제본들은 Postgres advisory lock으로 작업자 하나만 실행합니다. 여행별 진행 작업은 최대 두 개이며 일일 한도는 DB 잠금으로 함께 계산합니다. 공급자 제출 타임아웃이나 제출 직후 서버 종료에는 중복 비용을 피하려고 `submission_unknown`으로 멈춥니다. 해당 작업을 다시 생성하기 전에 공급자 콘솔의 접수·사용 기록을 확인해야 합니다. 공급자 작업 ID를 받기 전 연결이 끊겼으면 자동 원격 삭제도 확인할 수 없습니다.

결과와 참조 자료는 여행 생성 후 48시간까지만 제공합니다. 삭제·자료 변경·만료 후 정리 작업이 S3 자료를 지우고 공급자 요청도 취소 또는 삭제합니다. 공급자에서 이미 생성 중인 요청은 취소할 수 없으므로 완료 후 삭제하며, 그동안의 비용이 발생할 수 있습니다. 네트워크 장애 중에는 정리가 재시도 상태로 남습니다. 입력 전달용 서명 URL은 최대 1시간입니다. API는 결과 S3 URL을 외부에 직접 노출하지 않습니다.

컨테이너는 쓰기 가능한 `/tmp` 공간이 필요합니다. 생성 조각·합성본을 함께 다루므로 기존 256Mi 제한보다 넉넉한 메모리를 배정해야 합니다. API·CDN HTTPS와 S3·STS 통신도 배포 정책에서 허용해야 합니다. 키 발급과 결제 잔액은 별개이며, 웹 구독만으로 API 잔액이 생긴다고 가정하지 않습니다.

## 검증 범위

단위 검사는 템플릿 분할·참조 캐릭터·미확인 화자·프롬프트 비식별화·자막 보존·공급자 오류·CDN 다운로드 제한을 확인합니다. Postgres와 HTTP 통합 검사는 동시 멱등 요청, 한도, 두 작업자 경합, 원음·자막 변경, 동의 철회, 합성 중 삭제, 불명확 제출의 재시도 방지를 확인합니다. 이 검사의 공급자 영상은 대역이며 실제 생성 품질의 증거는 아닙니다. 실제 API 생성·원음 합성 결과와 비용은 작업별 실행 기록으로 따로 확인합니다.

공식 계약: [인증](https://docs.higgsfield.ai/docs/authentication), [비동기 요청·취소·삭제](https://docs.higgsfield.ai/docs/concepts/requests), [Seedance 2.5 참조 영상](https://open.higgsfield.ai/models/bytedance/seedance-2.5/reference-to-video/api-reference).
