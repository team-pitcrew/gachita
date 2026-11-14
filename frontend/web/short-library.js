const DATABASE = "gachita-short-library";
const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => request.result.createObjectStore("videos", { keyPath: "key" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error("이 기기의 보관함을 열지 못했어요."));
});
async function transaction(mode, work) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("videos", mode);
      const request = work(tx.objectStore("videos"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(new Error("보관함에 저장하지 못했어요. 기기의 저장 공간을 확인해 주세요."));
    });
  } finally { db.close(); }
}
export const readShortLibrary = async (owner) => owner ? (await transaction("readonly", (s) => s.getAll())).filter((x) => x.owner === owner).sort((a, b) => b.savedAt - a.savedAt) : [];
export const removeLibraryShort = (owner, id) => transaction("readwrite", (s) => s.delete(`${owner}:${id}`));
export async function keepLibraryShort(owner, item) {
  if (!owner) throw new Error("내 프로필이나 여행에 연결한 뒤 보관해 주세요.");
  if (!(item.file instanceof Blob) || !item.file.type.startsWith("video/") || !item.file.size) throw new Error("완성된 영상 파일이 필요해요.");
  await transaction("readwrite", (s) => s.put({ ...item, key: `${owner}:${item.id}`, owner, savedAt: Date.now() }));
}

// 사용자가 보관한 파일에서만 표지를 만듭니다. 외부 이미지나 생성 전 캐릭터를 결과 표지로 쓰지 않습니다.
export async function shortPoster(file) {
  const video = document.createElement("video"), url = URL.createObjectURL(file);
  video.muted = true; video.playsInline = true; video.preload = "auto";
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("표지를 불러오지 못했어요.")), 8000);
      const done = (fn) => { clearTimeout(timeout); fn(); };
      video.onloadeddata = () => { video.currentTime = Math.min(0.15, video.duration / 2); };
      video.onseeked = () => done(resolve);
      video.onerror = () => done(() => reject(new Error("영상 형식을 확인해 주세요.")));
      video.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 216; canvas.height = Math.round(216 * video.videoHeight / video.videoWidth);
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
  } finally { video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url); }
}
