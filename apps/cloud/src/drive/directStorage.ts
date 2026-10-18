import { AwsClient } from "aws4fetch";

export const DIRECT_UPLOAD_URL_SECONDS = 15 * 60;
export const MAX_DIRECT_INDEX_BYTES = 24 * 1024 * 1024;

/** S3 access to the bucket drives' packs live in: R2's S3 API. */
export interface DirectUploadsEnv {
  readonly DRIVE_PACKS_S3_ACCESS_KEY_ID?: string;
  readonly DRIVE_PACKS_S3_SECRET_ACCESS_KEY?: string;
  /** `https://<account>.eu.r2.cloudflarestorage.com` for the EU jurisdiction. */
  readonly DRIVE_PACKS_S3_ENDPOINT?: string;
  /** The packs bucket's name, as `DRIVE_PACKS` binds it. */
  readonly DRIVE_PACKS_BUCKET_NAME?: string;
}

const nonEmpty = (value: string | undefined) =>
  value === undefined || value.trim() === "" ? null : value.trim();

/** What direct uploads need of storage beyond the bucket binding. */
export interface DirectStorage {
  /** A URL anyone may `PUT` the object at `key` to, for a little while. */
  readonly presignPut: (key: string, size: number) => Promise<string>;
  /** Copies `from` to `to` within the bucket, the bytes never passing through here. */
  readonly copy: (from: string, to: string) => Promise<void>;
}

/** The packs bucket through R2's S3 API; null without credentials. */
export const directStorageSettings = (env: DirectUploadsEnv) => {
  const accessKeyId = nonEmpty(env.DRIVE_PACKS_S3_ACCESS_KEY_ID);
  const secretAccessKey = nonEmpty(env.DRIVE_PACKS_S3_SECRET_ACCESS_KEY);
  const endpoint = nonEmpty(env.DRIVE_PACKS_S3_ENDPOINT)?.replace(/\/+$/, "") ?? null;
  const bucketName = nonEmpty(env.DRIVE_PACKS_BUCKET_NAME);
  if (
    accessKeyId === null ||
    secretAccessKey === null ||
    endpoint === null ||
    bucketName === null
  ) {
    return null;
  }
  const s3 = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  const path = (key: string) =>
    `/${bucketName}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return { s3, endpoint, bucketName, path };
};

export const s3Storage = (env: DirectUploadsEnv): DirectStorage | null => {
  const settings = directStorageSettings(env);
  if (settings === null) return null;
  const { s3, endpoint, path } = settings;
  return {
    presignPut: async (key, size) => {
      const url = new URL(`${endpoint}${path(key)}`);
      url.searchParams.set("X-Amz-Expires", String(DIRECT_UPLOAD_URL_SECONDS));
      const signed = await s3.sign(
        new Request(url, { method: "PUT", headers: { "content-length": String(size) } }),
        {
          aws: { signQuery: true, allHeaders: true },
        },
      );
      return signed.url;
    },
    copy: async (from, to) => {
      const response = await s3.fetch(`${endpoint}${path(to)}`, {
        method: "PUT",
        headers: { "x-amz-copy-source": path(from) },
      });
      // S3 may answer a failed copy with 200 and an error in the body.
      const body = await response.text();
      if (!response.ok || body.includes("<Error>")) {
        throw new Error(`Copying an upload answered ${response.status}.`);
      }
    },
  };
};
