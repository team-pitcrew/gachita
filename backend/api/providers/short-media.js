import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export const mediaReady = () =>
  Boolean(process.env.SHORTS_BUCKET || process.env.CLIPS_BUCKET);
export function shortMedia() {
  const bucket = process.env.SHORTS_BUCKET || process.env.CLIPS_BUCKET;
  if (!bucket) throw { status: 503, error: "쇼츠 저장소가 준비되지 않았어요" };
  const client = new S3Client({
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 60_000 },
  });
  return {
    put: async (key, body, type) => {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: type,
        }),
      );
    },
    get: async (key) => {
      const r = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (r.ContentLength > 64_000_000) throw Error("media_too_large");
      const data = Buffer.from(await r.Body.transformToByteArray());
      if (data.length > 64_000_000) throw Error("media_too_large");
      return data;
    },
    remove: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
