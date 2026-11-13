// 서버가 허용한 공유 결과의 표시 필드만 이미지로 만든다. 계정·여행 식별자와 토큰은 그리지 않는다.
const FONT = 'system-ui, -apple-system, "Noto Sans KR", sans-serif';
const text = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();

export function shareCardText(item) {
  return {
    title: text(item.label) || "함께 남긴 장면",
    caption: text(item.caption) || "추가 문구 없음",
    time: new Date(item.at).toLocaleString("ko-KR", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    location: Number.isFinite(item.lat) && Number.isFinite(item.lng) ? `${item.lat.toFixed(5)}, ${item.lng.toFixed(5)}` : "",
  };
}

// 긴 한국어·공백 없는 문구도 자르지 않고, 이모지의 결합 문자는 같은 줄에 둔다.
export function wrapCardText(value, measure, width) {
  const segments = new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(value);
  const lines = [];
  let line = "";
  for (const { segment } of segments) {
    if (line && measure(line + segment) > width) { lines.push(line.trimEnd()); line = ""; }
    line += segment;
  }
  if (line) lines.push(line.trimEnd());
  return lines;
}

export async function shareCardPng(item) {
  const card = shareCardText(item);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("이 브라우저에서 이미지를 만들 수 없어요.");
  ctx.font = `700 60px ${FONT}`;
  const title = wrapCardText(card.title, (s) => ctx.measureText(s).width, 888);
  ctx.font = `400 38px ${FONT}`;
  const caption = wrapCardText(card.caption, (s) => ctx.measureText(s).width, 856);
  canvas.width = 1080;
  canvas.height = Math.max(1080, 630 + title.length * 78 + caption.length * 58);
  ctx.fillStyle = "#f6f4f1";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#60c090";
  ctx.fillRect(72, 80, 48, 8);
  ctx.fillStyle = "#2b7a53";
  ctx.font = `700 36px ${FONT}`;
  ctx.fillText("가치타", 140, 100);
  ctx.fillStyle = "#5a5044";
  ctx.font = `400 28px ${FONT}`;
  ctx.fillText("동승자와 나눈 장면", 72, 164);
  ctx.fillStyle = "#28221b";
  ctx.font = `700 60px ${FONT}`;
  let y = 286;
  for (const line of title) { ctx.fillText(line, 72, y); y += 78; }
  ctx.font = `400 28px ${FONT}`;
  ctx.fillStyle = "#5a5044";
  ctx.fillText(card.time, 72, y + 4);
  y += 80;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(72, y, 936, caption.length * 58 + 84, 24);
  ctx.fill();
  ctx.fillStyle = "#28221b";
  ctx.font = `400 38px ${FONT}`;
  y += 64;
  for (const line of caption) { ctx.fillText(line, 112, y); y += 58; }
  if (card.location) {
    ctx.fillStyle = "#5a5044";
    ctx.font = `400 26px ${FONT}`;
    ctx.fillText(`함께 보낸 위치  ${card.location}`, 72, y + 90);
  }
  ctx.fillStyle = "#5a5044";
  ctx.font = `400 26px ${FONT}`;
  ctx.fillText("함께한 순간, 함께 간직해요.", 72, canvas.height - 76);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("이미지를 저장하지 못했어요. 다시 시도해 주세요.")), "image/png"));
}
