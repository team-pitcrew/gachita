// 프로필 사진의 S3 키와, 옛 사진(profiles.photo bytea)을 S3로 옮기는 일(T178, ADR-0027).
// 옮기기: 운영 파드 안에서 `node backend/api/profile-photos.js`. 한 번 실행하면 되고, 다시 돌려도 안전하다 —
// 이미 옮긴 줄(photo_key가 있음)은 건너뛰고, 키가 내용 해시라 같은 사진을 다시 올려도 같은 객체다.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { endStores, profilesDb } from "./db.js";
import { clipStore } from "./providers/clips.js";

export const photoKey = (profileId, bytes, type) =>
  `profiles/${profileId}/photo/${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${type === "image/png" ? "png" : "jpg"}`;

// 옮긴 줄 수를 돌려준다. 옮기는 사이 본인이 사진을 바꾸거나 지운 줄은 건드리지 않는다(그 줄의 옛 객체는 leftover로 돌려줘 지우게 한다).
export async function movePhotos({ db = profilesDb(), store = clipStore() } = {}) {
  if (!store) throw Error("CLIPS_BUCKET이 없어 옮길 곳이 없음");
  const leftover = [];
  let moved = 0;
  for (let last = "00000000-0000-0000-0000-000000000000"; ; ) {
    const { rows } = await db.query("SELECT id, photo, photo_type FROM profiles WHERE photo IS NOT NULL AND photo_key IS NULL AND id > $1 ORDER BY id LIMIT 20", [last]);
    if (!rows.length) return { moved, leftover };
    for (const r of rows) {
      const key = photoKey(r.id, r.photo, r.photo_type);
      await store.put(key, r.photo, r.photo_type);
      const { rowCount } = await db.query("UPDATE profiles SET photo_key = $2, photo = NULL WHERE id = $1 AND photo_key IS NULL AND photo = $3", [r.id, key, r.photo]);
      if (rowCount) moved++;
      else leftover.push(key);
      last = r.id;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { moved, leftover } = await movePhotos();
  if (leftover.length) await clipStore().remove(leftover);
  console.log(JSON.stringify({ moved, skipped: leftover.length }));
  await endStores();
}
