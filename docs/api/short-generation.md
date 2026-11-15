# 쇼츠 서버 생성 API

고른 장면 하나로 9:16 쇼츠를 만듭니다. API는 작업을 큐에 두고, 운영자 맥의 **생성 일꾼**이 받아 갑니다. 일꾼은 Codex(OpenAI 구독, gpt-6-astra, 추론 xhigh)와 [youtube-shorts-factory](https://github.com/ninestonelee/youtube-shorts-factory) 스킬로 장면 그림을 만들고, 원래 목소리·자막과 합쳐 올립니다. 결정과 남은 위험은 [ADR-0025](../adr/0025-shorts-generation-worker-codex-skill.md)에 있습니다. 기존 `/shortform`(구성 재생)과 `/short-assets`(기기에서 만든 영상)는 그대로입니다.

## 템플릿과 제작 계획

| 템플릿 | 그림 |
|---|---|
| `car-sitcom-v1` | 차 안 두 캐릭터의 2D 시트콤 장면 |
| `travel-postcard-v1` | 같은 캐릭터와 창밖 수채 풍경의 여행 엽서 |

15~45초 장면을 5~8초 칸으로 나누고 칸마다 그림 한 장을 만듭니다. 출연 캐릭터는 그 장면에서 많이 말한 순서로 네 사람까지의 프로필 캐릭터(`frontend/web/chars/{character}.png`)입니다. 화자 대조가 없으면 이름을 추측하지 않고 기본 캐릭터와 '화자 미확인' 자막을 씁니다. 그림에는 사람·실제 얼굴·글자를 넣지 않습니다. 자막(Noto Sans CJK KR 지정)과 소리(녹음 클립)는 일꾼이 마지막에 합칩니다. 결과는 720×1280 H.264/AAC MP4입니다.

`externalData`는 OpenAI(미국)로 가는 것입니다: 장면의 받아 적은 글(참가자 이름은 캐릭터 번호로 바꿈)과 출연 캐릭터 그림. 소리는 보내지 않습니다. `audioReference: true`는 400입니다(옛 앱의 `false`는 받습니다).

## 앱의 호출 순서

참가자 토큰을 `Authorization: Bearer <participant-token>`으로 보냅니다. 동승자 전원이 녹음에 동의해야 합니다.

1. `GET /api/short-templates`: 템플릿과 `enabled`, `provider: "openai-codex"`.
2. `POST /api/trips/{code}/short-plans`: `{ "templateId":"car-sitcom-v1" }`. `momentId`를 빼면 준비된 장면을 추천합니다. 응답의 `externalData`·캐릭터·자막·칸을 사람에게 보여 줍니다.
3. `POST /api/trips/{code}/short-generations`: 아래 본문으로 제작을 맡깁니다. 202, 같은 키·내용의 재전송은 200입니다.
4. `GET /api/trips/{code}/short-generations/{id}`로 상태를 봅니다. 목록은 `{id}`를 뺍니다.
5. `completed`이면 `result.url`을 같은 참가자 인증으로 받습니다. 콘텐츠 기록(`GET /profiles/me/trips`, `GET /trips/{code}/contents`)에도 `kind: generated`로 나옵니다.
6. `DELETE /api/trips/{code}/short-generations/{id}`는 만든 사람이 취소·삭제합니다. 파일 접근은 바로 막히고 S3 정리는 이어서 합니다.

```json
{
  "momentId": "제작 계획의 momentId",
  "templateId": "car-sitcom-v1",
  "generation": 1,
  "planHash": "제작 계획의 planHash",
  "externalGenerationConsent": true,
  "idempotencyKey": "client-request-unique-id"
}
```

키는 8~100자 영문·숫자·`_`·`-`입니다. 주행 중이면 409, 자막·원음·화자·캐릭터가 바뀌면 계획을 다시 받아야 합니다(409). 동의를 철회하면 기존 작업과 결과를 쓸 수 없습니다.

| 상태 | 의미 |
|---|---|
| `queued` | 작업을 저장했고 일꾼을 기다립니다. 일꾼이 꺼져 있으면 여기 머뭅니다. |
| `generating` | 일꾼이 임대해 만들고 있습니다(최대 60분). |
| `completed` | 결과 파일을 받을 수 있습니다. |
| `failed` | 일꾼이 실패를 알렸거나(`errorCode: worker_*`) 임대 안에 끝내지 못했습니다(`worker_timeout`). 다시 내주지 않습니다. |
| `canceled` | 삭제·철회·자료 변경으로 쓸 수 없습니다. |

## 생성 일꾼 계약

일꾼 토큰 하나만 받습니다: `Authorization: Bearer <SHORTS_WORKER_TOKEN>`(32자 이상). 사람 토큰이나 틀린 토큰은 401입니다. 일꾼은 밖으로만 연결합니다.

| 요청 | 응답 |
|---|---|
| `POST /api/short-worker/claim` | 대기 중 가장 오래된 작업을 60분 임대해 200 `{id, leaseUntil, template:{id,name,direction}, plan, audio, thumbnail, result}`(thumbnail은 T166). 없거나 꺼져 있으면 204. 내주기 전에 동의·원본을 다시 보고, 바뀌었으면 취소하고 204 |
| `GET /api/short-worker/jobs/{id}/audio` | 장면 원음 WAV. 임대 중인 작업만(아니면 410) |
| `PUT /api/short-worker/jobs/{id}/thumbnail` | 표지 그림(T166). 본문은 `image/png`(3 MB까지, PNG 서명 검사). 임대 중인 작업만. 동의·원본을 다시 보고 S3 `shorts/{id}/thumbnail.png`에 둡니다(다시 올리면 덮음). 키를 `object_keys`에 먼저 적어 취소·철회 정리가 영상과 함께 지웁니다. 200 `{id, thumbnailUrl}` |
| `PUT /api/short-worker/jobs/{id}/result` | 본문은 `video/mp4` 바이트(최대 64 MB). 기본 영상과 같은 ffprobe 검사(9:16, 영상·소리 하나씩, 장면 길이와 1초 안) 뒤 동의·원본을 다시 보고 S3 `shorts/{id}/final.mp4`에 둡니다. 200은 `completed`. 그사이 철회·자료 변경이면 작업을 취소하고 403/409/410 |
| `POST /api/short-worker/jobs/{id}/fail` | `{ "errorCode": "ffmpeg_failed" }`(영소문자·숫자·`_`). `failed`, `errorCode: worker_<값>` |

`plan`에는 자막에 쓸 출연자 이름이 들어 있습니다. 일꾼은 Codex에 넘기기 전에 이름·참가자 id를 빼고 캐릭터 번호로 바꿉니다.

## 서버 설정

| 환경 변수 | 값과 용도 |
|---|---|
| `SHORTS_ENABLED` | `true`일 때 새 작업을 받고 일꾼에게 내줍니다. 기본은 꺼짐입니다. |
| `SHORTS_WORKER_TOKEN` | 일꾼 토큰(32자 이상). SSM `/gachita/dev/app/shorts-worker/SHORTS_WORKER_TOKEN` → ExternalSecret `shorts-worker`. 없으면 꺼짐과 같습니다. |
| `SHORTS_BUCKET` | 결과 S3 버킷. 생략하면 `CLIPS_BUCKET`입니다. |
| `SHORTS_DAILY_SECONDS` | 하루 전체 작업의 칸 길이 합 상한(기본 120초). 취소·실패도 그날 한도에서 빼지 않습니다. |
| `SHORTS_TRIP_JOBS` | 여행(동의 세대)마다 만들 수 있는 작업 수(기본 3). |

서버 안에서는 지키기만 합니다. 2초마다 하나씩(여러 파드 중 advisory lock을 쥔 하나) 동의 철회·자료 변경을 다시 보고, 끝난 임대를 `worker_timeout`으로 돌리고, 취소된 결과를 S3에서 지웁니다. 결과 파일에는 시간 만료가 없습니다(T90).

## 일꾼 돌리기(운영자 맥)

[`backend/api/shorts-worker/README.md`](../../backend/api/shorts-worker/README.md)에 있습니다. Node 22, ffmpeg, `codex login`(ChatGPT)이 필요합니다.

## 검증 범위

- 서버 시험(Postgres): 계획·멱등·하루/여행 상한·일꾼 토큰·임대·중복 임대 없음·원음 내려받기·파일 검사 실패·완료와 다운로드·자막 변경과 철회 뒤 취소·임대 만료·실패 알림·만드는 중 삭제·올리는 사이 철회의 S3 정리. S3와 ffprobe는 대역입니다.
- 일꾼 시험: Codex에 주는 재료에 이름·id가 없음, 켄 번스 필터, 그림 경로 제한, (ffmpeg가 있으면) 그림 → 9:16 MP4 합성.
- 실제 Codex 생성은 작업별 실행 기록으로 따로 확인합니다.
