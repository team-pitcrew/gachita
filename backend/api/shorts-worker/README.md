# 쇼츠 생성 일꾼

운영자 맥에서 도는 일꾼입니다([ADR-0025](../../../docs/adr/0025-shorts-generation-worker-codex-skill.md), 계약은 [short-generation.md](../../../docs/api/short-generation.md)). API 이미지에는 들어가지 않습니다(`.dockerignore`).

1. API에 밖으로만 연결해 작업을 임대받습니다(`POST /api/short-worker/claim`, 15초마다).
2. Codex 스레드(ChatGPT 구독 로그인, `gpt-6-astra`, 추론 `xhigh`)가 [`skill/`](skill/)의 youtube-shorts-factory 스킬로 레퍼런스 분석 → 각색 → 스토리보드 → 장면 그림을 만듭니다. 인물은 프로필 캐릭터 그림(`frontend/web/chars/`)을 투사합니다.
3. 그림마다 켄 번스(ffmpeg)를 주고, 원래 목소리와 자막(`../short-render.js`)을 합쳐 720×1280 MP4를 올립니다.

`skill/`은 [ninestonelee/youtube-shorts-factory](https://github.com/ninestonelee/youtube-shorts-factory) 커밋 `4476e9a`를 그대로 옮긴 것입니다(MIT, `skill/LICENSE`). 스킬 6–7단계(HTML, Veo·TTS)와 실사 스타일 고정값은 일꾼 지침(`worker.mjs`의 `prompt`)이 덮어씁니다.

## 준비

- Node 22, ffmpeg(libass 포함), `codex login`(ChatGPT). `codex login status`가 `Logged in using ChatGPT`이면 됩니다.
- `npm ci`(이 폴더). `@openai/codex-sdk`가 Codex 실행 파일을 함께 받습니다. 인증은 맥의 `~/.codex`를 그대로 씁니다. 이 파일을 복사하거나 다른 곳으로 옮기지 않습니다.
- 환경 파일 `~/.config/gachita/shorts-worker.env`(권한 600, 저장소 밖):

  ```sh
  GACHITA_API=https://gachita.mangowhois.ai
  SHORTS_WORKER_TOKEN=<API의 SHORTS_WORKER_TOKEN과 같은 값>
  ```

  토큰은 운영자가 한 번 만들어(`openssl rand -hex 32`) 두 곳에 넣습니다: 이 파일과 `gh secret set SHORTS_WORKER_TOKEN -R team-pitcrew/gachita` → `infra-secrets` 워크플로가 SSM `/gachita/dev/app/shorts-worker/SHORTS_WORKER_TOKEN`으로 옮깁니다.

## 돌리기

```sh
npm start        # 계속 돌며 작업을 받는다
npm run once     # 작업 하나만(없으면 바로 끝남)
```

- 한 줄짜리 JSON 기록을 냅니다: `claimed` → `completed`(바이트, 걸린 시간, Codex 토큰 사용량, 각색 요약) 또는 `failed`(단계 코드).
- `SHORTS_KEEP=1`이면 작업 폴더(`$TMPDIR/gachita-short-*`: 장면 그림, `storyboard.json`, `adaptation.md`)를 지우지 않습니다. 확인한 뒤 손으로 지웁니다.
- 레퍼런스 분석은 처음 한 번 `~/.gachita-shorts/reference-analysis.md`에 남고 다음 작업이 다시 씁니다.

## 시험

`node --test`(이 폴더 또는 `backend/api`에서). ffmpeg가 있으면 그림 → MP4 합성까지 실제로 돌립니다. Codex는 대역입니다.
