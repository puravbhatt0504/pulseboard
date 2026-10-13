import { randomUUID } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { HttpError } from "../http.js";

export const MAX_BYTES = 10 * 1024 * 1024;
const URL_TTL_S = 5 * 60;
// Explicit list: no SVG (scriptable) and nothing executable.
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

let client: S3Client | undefined;

// ContentType and ContentLength are signed, so the upload must match what was declared here.
export async function presignAttachment(cardId: string, filename: unknown, contentType: unknown, size: unknown) {
  if (typeof filename !== "string" || !filename || filename.length > 200) throw new HttpError(400, "filename required");
  if (typeof contentType !== "string" || !ALLOWED.has(contentType)) throw new HttpError(400, "only images and PDFs are allowed");
  if (typeof size !== "number" || !Number.isInteger(size) || size <= 0 || size > MAX_BYTES) {
    throw new HttpError(400, `size must be 1-${MAX_BYTES} bytes`);
  }
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new HttpError(503, "uploads not configured"); // e.g. the Render demo has no S3
  client ??= new S3Client({});
  const key = `attachments/${cardId}/${randomUUID()}-${filename.replace(/[^\w.-]/g, "_")}`;
  const url = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn: URL_TTL_S },
  );
  return { url, key };
}
