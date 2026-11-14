// 녹음 클립 저장소(T76). S3 클립 전용 버킷 하나(CLIPS_BUCKET: 서울, 버전 관리 끔, 2일 수명 규칙)만 안다.
// 서버의 나머지는 이 파일만 안다(providers/ 관례). 자격은 SDK의 기본 자격 체인(서비스 계정 역할)이다 —
// 손으로 서명하지 않는다. 엔드포인트도 SDK의 표준 설정(AWS_ENDPOINT_URL_S3)을 따르므로 시험은 가짜 S3를 그 주소에 둔다.
// 버킷이 없으면 clipStore()가 null이고, API는 503(저장소 없음)으로 답한다.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

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
    // 한 요청에 1000개까지 묶는다(DeleteObjects). 키 하나라도 못 지웠으면 503.
    remove: async (keys) => {
      for (let i = 0; i < keys.length; i += 1000) {
        const objects = keys.slice(i, i + 1000).map((Key) => ({ Key }));
        const r = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } })).catch(unavailable);
        if (r.Errors?.length) unavailable({ name: r.Errors[0].Code });
      }
    },
  };
}

// 여행 전체 음성(ADR-0024). 같은 클립 버킷에 조각(4 MiB까지)과, 조각을 이은 객체 하나를 둔다.
// 조각과 합치기(멀티파트 8 MiB씩)는 클립보다 커서 시간 제한이 긴 클라이언트를 따로 둔다.
// 장면 자르기는 객체 전체를 받지 않고 바이트 범위(Range)만 읽는다.
let audioClient = null;
export function audioStore() {
  const bucket = process.env.CLIPS_BUCKET;
  if (!bucket) return null;
  // ponytail: 시간 제한은 고정값. 8 MiB 한 번을 60초에 못 보내면 버킷이 아니라 길이 문제라 다시 하게 둔다.
  audioClient ??= new S3Client({ maxAttempts: 3, requestHandler: { connectionTimeout: 5000, requestTimeout: 60_000 } });
  const send = (command) => audioClient.send(command).catch(unavailable);
  const bytes = async (r) => Buffer.from(await r.Body.transformToByteArray());
  return {
    put: (key, body, type = "application/octet-stream") => send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: type })),
    get: (key) =>
      audioClient
        .send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        .then(bytes)
        .catch((e) => (e?.name === "NoSuchKey" ? null : unavailable(e))),
    // [start, end) 바이트. 없는 키면 null.
    range: (key, start, end) =>
      audioClient
        .send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${start}-${end - 1}` }))
        .then(bytes)
        .catch((e) => (e?.name === "NoSuchKey" ? null : unavailable(e))),
    // 멀티파트로 객체 하나를 만든다. 조각마다 5 MiB 이상(마지막 빼고)은 부르는 쪽이 지킨다.
    multipart: async (key, type = "application/octet-stream") => {
      const { UploadId } = await send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: type }));
      const parts = [];
      return {
        part: async (body) => {
          const PartNumber = parts.length + 1;
          parts.push(null);
          const r = await send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId, PartNumber, Body: body }));
          parts[PartNumber - 1] = { PartNumber, ETag: r.ETag, ...(r.ChecksumCRC32 ? { ChecksumCRC32: r.ChecksumCRC32 } : {}) };
        },
        complete: () => send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId, MultipartUpload: { Parts: parts } })),
        // 못 지워도 던지지 않는다 — 버킷 수명 규칙(끝내지 못한 멀티파트 1일)이 치운다. 지금 API 역할에는 이 권한이 없을 수 있다.
        abort: () => audioClient.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId })).then(() => true, () => false),
      };
    },
  };
}
