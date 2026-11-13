// 녹음 클립 저장소(T76). S3 클립 전용 버킷 하나(CLIPS_BUCKET: 서울, 버전 관리 끔, 2일 수명 규칙)만 안다.
// 서버의 나머지는 이 파일만 안다(providers/ 관례). 자격은 SDK의 기본 자격 체인(서비스 계정 역할)이다 —
// 손으로 서명하지 않는다. 엔드포인트도 SDK의 표준 설정(AWS_ENDPOINT_URL_S3)을 따르므로 시험은 가짜 S3를 그 주소에 둔다.
// 버킷이 없으면 clipStore()가 null이고, API는 503(저장소 없음)으로 답한다.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// S3에 닿지 못하면 다시 해도 되는 503. 원래 오류의 이름은 요청 로그에 남는다(errFields가 name을 읽음).
const unavailable = (e) => {
  throw { status: 503, error: "클립 저장소에 닿지 못함", name: e?.name ?? "S3Error" };
};

let client = null;
export function clipStore() {
  const bucket = process.env.CLIPS_BUCKET;
  if (!bucket) return null;
  // ponytail: 시간 제한은 고정값. 클립은 150~250 KB(11/13 실측)라 5초면 넉넉하다.
  client ??= new S3Client({ maxAttempts: 2, requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 } });
  return {
    put: (key, body) => client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "audio/wav" })).catch(unavailable),
    // 없는 키면 null. 버킷의 ListBucket 권한이 있어야 S3가 403 대신 NoSuchKey로 답한다(T64).
    get: (key) =>
      client
        .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        .then(async (r) => Buffer.from(await r.Body.transformToByteArray()))
        .catch((e) => (e?.name === "NoSuchKey" ? null : unavailable(e))),
    // 버전 관리를 끈 버킷이라 한 번 지우면 남는 버전이 없다. 없는 키를 지워도 S3는 성공으로 답한다.
    remove: (keys) => Promise.all(keys.map((key) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })))).catch(unavailable),
  };
}
