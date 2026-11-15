import { createHash } from "node:crypto";

// 만드는 쪽은 생성 일꾼(ADR-0025): Codex(gpt-6-astra, 추론 xhigh)가 스킬로 장면 그림을 그리고, 일꾼이 원음·자막과 합친다.
export const MODEL = "gpt-6-astra";
export const templates = [
  {
    id: "car-sitcom-v1",
    version: 1,
    name: "차 안 대화극",
    description: "두 캐릭터의 대화와 반응을 원래 목소리로 남겨요.",
    aspectRatio: "9:16",
    minSeconds: 15,
    maxSeconds: 45,
    direction:
      "Warm hand-drawn 2D sitcom frames inside a modern car. Confident thick charcoal outlines, the supplied white rounded characters exactly as drawn, soft cel shading, warm mint upholstery, sunset through the windows. Dashboard-facing group shot with every supplied character in their seat; clear eye-lines and readable expressions. No photorealism, no human faces.",
  },
  {
    id: "travel-postcard-v1",
    version: 1,
    name: "여행 엽서",
    description: "함께 나눈 대화에 여행의 분위기를 담아요.",
    aspectRatio: "9:16",
    minSeconds: 15,
    maxSeconds: 45,
    direction:
      "Beautifully illustrated travel postcard frames. All supplied rounded white characters together in a car, warm watercolor landscape through the windows, paper grain, sunlit sage and cream palette. Characters remain large and expressive; no map labels, real landmarks, addresses, or location text. No photorealism, no human faces.",
  },
];
export const characters = new Set(
  [
    "basic",
    "cap",
    "glasses",
    "travel",
    "game",
    "sport",
    "pet",
    "camping",
    "office",
    "healing",
  ].flatMap((x) => [x, `${x}-small`]),
);
export const fingerprint = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const invalid = (error) => {
  throw { status: 400, error };
};
const round = (n) => Math.round(n * 1000) / 1000;

export function planShort(source, options = {}) {
  const template =
    templates.find((t) => t.id === (options.templateId ?? templates[0].id)) ??
    invalid("없는 쇼츠 템플릿");
  // 원음은 생성 일꾼까지만 가고 OpenAI로는 보내지 않는다(ADR-0025). 옛 앱이 false를 보내는 것은 받는다.
  if (options.audioReference !== undefined && options.audioReference !== false)
    invalid("audioReference: 원음은 외부 생성에 보내지 않아요");
  const eligible = source.scenes.filter(
    (s) => s.seconds >= 15 && s.seconds <= 45 && s.cues.length,
  );
  const scene = options.momentId
    ? eligible.find((s) => s.momentId === options.momentId)
    : [...eligible].sort(
        (a, b) => b.cues.length - a.cues.length || b.at - a.at,
      )[0];
  if (!scene)
    throw {
      status: 409,
      error: "15~45초의 원음과 자막이 있는 장면이 필요해요",
    };
  const counts = new Map();
  for (const c of scene.cues)
    if (c.participantId)
      counts.set(c.participantId, (counts.get(c.participantId) ?? 0) + 1);
  const selected = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => source.cast.find((c) => c.participantId === id))
    .filter(Boolean)
    .slice(0, 4);
  // 많이 말한 순서로 네 명까지 캐릭터로 나온다(가족 넷). 화자 대조가 없으면 이름 없는 기본 캐릭터 둘.
  const cast = Array.from({ length: Math.max(2, selected.length) }, (_, i) => {
    const c = selected[i];
    return {
      slot: i,
      participantId: c?.participantId ?? null,
      name: c?.name ?? "화자 미확인",
      character: characters.has(c?.character)
        ? c.character
        : i
          ? "basic-small"
          : "basic",
      seat: c?.seat ?? null,
    };
  });
  const cues = scene.cues.map((c) => ({
    start: c.start,
    end: c.end,
    text: c.text,
    device: c.device,
    seq: c.seq,
    editVersion: c.editVersion,
    participantId: c.participantId,
    slot:
      cast.find((x) => x.participantId && x.participantId === c.participantId)
        ?.slot ?? null,
  }));
  // 5~8초 장면 그림 단위(스토리보드 한 칸 = 그림 한 장 = 켄 번스 한 조각).
  const count = Math.ceil(scene.seconds / 8);
  const shots = Array.from({ length: count }, (_, i) => {
    const start = round((scene.seconds * i) / count),
      end = round((scene.seconds * (i + 1)) / count);
    const turns = cues
      .filter((c) => c.start < end && c.end > start)
      .map((c) => ({
        at: round(Math.max(0, c.start - start)),
        until: round(Math.min(end - start, c.end - start)),
        speakerSlot: c.slot,
        reaction: /[ㅋㅎ]{2}|웃|하하|하하하/.test(c.text)
          ? "warm chuckle"
          : "attentive listening",
      }));
    const beat = i === 0 ? "hook" : i === count - 1 ? "payoff" : "exchange";
    return {
      index: i,
      start,
      end,
      seconds: round(end - start),
      generationSeconds: Math.ceil(end - start),
      beat,
      turns,
    };
  });
  const plan = {
    schemaVersion: 1,
    templateId: template.id,
    templateVersion: template.version,
    model: MODEL,
    resolution: "720p",
    width: 720,
    height: 1280,
    fps: 30,
    momentId: scene.momentId,
    generation: source.generation,
    title: (scene.label || source.title || "우리 차 안에서").slice(0, 40),
    seconds: scene.seconds,
    cast,
    cues,
    shots,
    audioReference: false,
    externalData: [
      "OpenAI(미국)로: 장면의 받아 적은 글(이름 대신 캐릭터 번호)",
      "OpenAI(미국)로: 출연 캐릭터 그림",
    ],
    estimatedGenerationSeconds: shots.reduce(
      (n, s) => n + s.generationSeconds,
      0,
    ),
    selectionReason: "원음과 자막이 준비된 장면",
    warnings: [
      ...(cues.some((c) => c.slot === null)
        ? [
            "일부 화자는 두 캐릭터와 연결되지 않았습니다. 이름을 추측하지 않습니다.",
          ]
        : []),
      "인물은 프로필 캐릭터 그림으로만 그리고 실제 얼굴·사진을 쓰지 않습니다. 소리는 원래 목소리입니다.",
    ],
  };
  return {
    ...plan,
    planHash: fingerprint({
      plan,
      sourceRevision: scene.sourceRevision ?? null,
    }),
  };
}

