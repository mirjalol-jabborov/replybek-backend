// Where uploaded files live. With S3_BUCKET set they go to an S3-compatible store (MinIO locally
// and on our servers; any S3 works); without it, to UPLOAD_DIR on this machine (tests, quick runs).
// A file is named by a key such as "attachments/<id>" or "<workspace_id>/<source_id>.pdf".
// Keys from before the store existed are absolute paths on disk, and are still read from there.
import fs from "node:fs/promises";
import path from "node:path";
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

const bucket = () => process.env.S3_BUCKET;
const localDir = () => path.resolve(process.env.UPLOAD_DIR || "./data/uploads");
const onDisk = (key) => (path.isAbsolute(key) ? key : path.join(localDir(), key));

let client;
function s3() {
  const { S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY } = process.env;
  return (client ||= new S3Client({
    endpoint: S3_ENDPOINT || undefined,
    region: S3_REGION || "us-east-1",
    forcePathStyle: true, // MinIO serves buckets as paths, not subdomains
    credentials: S3_ACCESS_KEY ? { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY } : undefined,
  }));
}

// The bucket is made on the first upload if it isn't there yet.
let ready;
function bucketReady() {
  return (ready ||= s3()
    .send(new HeadBucketCommand({ Bucket: bucket() }))
    .catch((e) => {
      if (e.$metadata?.httpStatusCode !== 404) throw e;
      return s3().send(new CreateBucketCommand({ Bucket: bucket() }));
    })
    .catch((e) => {
      ready = null;
      throw e;
    }));
}

/** Stores a file's bytes under a key. */
export async function putFile(key, buffer, type = "application/octet-stream") {
  if (!bucket()) {
    await fs.mkdir(path.dirname(onDisk(key)), { recursive: true });
    return fs.writeFile(onDisk(key), buffer);
  }
  await bucketReady();
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: buffer, ContentType: type }));
}

/** A stored file's bytes, or null when there's no such file. */
export async function getFile(key) {
  if (!bucket() || path.isAbsolute(key)) return fs.readFile(onDisk(key)).catch(() => null);
  try {
    const { Body } = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return Buffer.from(await Body.transformToByteArray());
  } catch (e) {
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/** Removes a stored file; a missing one is fine. */
export async function removeFile(key) {
  if (!bucket() || path.isAbsolute(key)) return fs.rm(onDisk(key), { force: true });
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
