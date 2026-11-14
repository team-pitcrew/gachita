import { createHash } from "node:crypto";

export const MODEL = "bytedance/seedance-2.5/reference-to-video";
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
      "Warm hand-drawn 2D animated sitcom inside a modern car. Confident thick charcoal outlines, simple white rounded characters, soft cel shading, warm mint upholstery, sunset through the windows. Dashboard-facing two-shot; clear eye-lines and readable expressions. Keep both complete character silhouettes and both arms visible. No static sticker collage. No photorealism.",
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
      "A beautifully illustrated moving travel postcard. Two rounded white characters in a car, warm watercolor landscape visible through the windows, restrained parallax, paper grain, sunlit sage and cream palette. Characters remain large and expressive. Keep complete silhouettes and both arms visible; no map labels, real landmarks, addresses, or location text.",
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
  if (
    options.audioReference !== undefined &&
    typeof options.audioReference !== "boolean"
  )
    invalid("audioReference: true 또는 false");
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
    .slice(0, 2);
  const cast = [0, 1].map((i) => {
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
  // 5~8초 촬영 단위. 마지막 조각도 모델의 4초 하한보다 짧아지지 않습니다.
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
    audioReference: options.audioReference === true,
    externalData:
      options.audioReference === true
        ? ["선택 캐릭터 이미지", "발화 시각과 반응 지시", "장면별 원음"]
        : ["선택 캐릭터 이미지", "발화 시각과 반응 지시"],
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
      "발화 끝 시각은 기존 전사에서 추정한 값입니다. 정밀 립싱크는 실제 생성 결과에서 확인해야 합니다.",
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

export function shotPrompt(plan, shot) {
  const t = templates.find((t) => t.id === plan.templateId);
  const timing = shot.turns
    .map(
      (x) =>
        `${x.at.toFixed(2)}–${x.until.toFixed(2)} seconds: ${x.speakerSlot === null ? "unidentified off-screen voice; neither character impersonates it" : `character ${x.speakerSlot + 1} speaks; character ${2 - x.speakerSlot} listens`}; ${x.reaction}.`,
    )
    .join("\n");
  return `${t.direction}\nCreate a single continuous ${shot.generationSeconds}-second animated shot, part ${shot.index + 1}/${plan.shots.length}. Reference image 1 is character 1 on the left. Reference image 2 is character 2 on the right. Preserve their exact shape, face, colors and accessories. Each character has exactly TWO arms; no additional limbs, duplicate bodies or morphing. Large characters occupy the central 65% of the frame. Leave top 15% and bottom 22% calm for titles and captions added later.\n${shot.beat === "hook" ? "Begin directly in a lively exchange; establish both characters in the first second." : shot.beat === "payoff" ? "Let the listener register the last remark with a clear blink and small delayed reaction. Hold the final reaction for half a second." : "Use tiny head turns, blinks and purposeful hand gestures. The listener reacts after the speaker, not continuously."}\nCamera stays inside the same car; gentle push-in only. No rapid cuts, camera orbit, outfit changes or characters appearing. No written words, subtitles, logos, watermark, fake UI or invented locations.\nTiming plan:\n${timing}\n${plan.audioReference ? "Use the attached original audio as the timing and articulation reference. Do not invent dialogue." : "No spoken dialogue or music. Animate the supplied turn timing; preserve pauses."}`;
}
