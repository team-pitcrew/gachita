import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
    sign: (key, seconds = 3600) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: Math.min(3600, seconds),
      }),
    remove: async (key) => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
// The provider returns CDN URLs. Only configured public HTTPS CDN hosts are downloaded, without credentials or redirects.
export async function downloadVideo(
  value,
  {
    fetcher = fetch,
    resolver = lookup,
    hosts = (
      process.env.HF_OUTPUT_HOSTS ||
      "cdn.higgsfield.ai,cdn.higgsfield.work,images.higgs.ai,d28lhcrx5qdowv.cloudfront.net"
    ).split(","),
  } = {},
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("invalid_video_url");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hosts.includes(url.hostname) ||
    isIP(url.hostname)
  )
    throw Error("untrusted_video_host");
  const addresses = await resolver(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) =>
      /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::|fc|fd|fe80|2001:db8)/i.test(
        address,
      ),
    )
  )
    throw Error("private_video_address");
  const r = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok || Number(r.headers.get("content-length")) > 64_000_000)
    throw Error("video_download_failed");
  const chunks = [];
  let bytes = 0;
  for await (const c of r.body) {
    bytes += c.length;
    if (bytes > 64_000_000) throw Error("video_too_large");
    chunks.push(c);
  }
  const data = Buffer.concat(chunks);
  if (data.length < 12 || data.toString("ascii", 4, 8) !== "ftyp")
    throw Error("not_mp4");
  return data;
}
