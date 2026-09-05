/**
 * R2: object keys and presigned URLs.
 *
 * This module is the only place the R2 S3 credentials are read, the way crypto.ts
 * is the only place the encryption key is read. They sign URLs and nothing else —
 * they are never returned in a response, and `safeErrorText` scrubs anything that
 * escapes through an error.
 *
 * Uploads do not pass through the Worker. The browser PUTs straight to R2 with a
 * presigned URL, so the Worker's own binding (`env.DOCS`) is used only to confirm
 * an object landed, stream it back, and delete it.
 *
 * A presigned URL is a bearer capability: whoever holds it can do that one thing
 * to that one key until it expires, with no further authentication. Both TTLs
 * here are the shortest that comfortably cover their operation.
 */

import { AwsClient } from 'aws4fetch';
import { ConfigError } from './crypto';
import type { Env } from './types';

/** Long enough to pick a file and upload it over a slow connection, and no longer. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * Long enough for a whole pass: TURN_TIMEOUT_MS is 4 minutes and reviewers run
 * three at a time, so a pass with several reviewers can still be fetching near
 * the end. This URL is handed to a third party — the Manyfold agent — so it buys
 * no more time than that.
 */
export const FETCH_URL_TTL_SECONDS = 60 * 60;

/** 10 MB. Stated in megabytes wherever a human sees it. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const formatLimit = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Where one document lives. Single source of truth: a download, a delete and a
 * review-wide cleanup all derive the key the same way, so they cannot drift.
 * Both ids are minted by us (`r-`/`d-` + a UUID), so neither can escape the prefix.
 */
export const documentKey = (reviewId: string, documentId: string): string =>
  `reviews/${reviewId}/${documentId}`;

/** Every object belonging to one review, for cleanup when it is deleted. */
export const reviewPrefix = (reviewId: string): string => `reviews/${reviewId}/`;

interface R2Config {
  client: AwsClient;
  bucket: string;
  accountId: string;
}

function config(env: Env): R2Config {
  const accountId = (env.R2_ACCOUNT_ID ?? '').trim();
  const accessKeyId = (env.R2_ACCESS_KEY_ID ?? '').trim();
  const secretAccessKey = (env.R2_SECRET_ACCESS_KEY ?? '').trim();
  const bucket = (env.R2_BUCKET ?? '').trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    // Deliberately names the missing capability rather than which variable is
    // unset: this reaches the browser, and the fix is the same for all four.
    throw new ConfigError(
      'File uploads are not configured on this deployment. Set the R2 credentials, or paste the document as text instead.',
    );
  }
  // region and service are required by SigV4 and ignored by R2.
  return {
    client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }),
    bucket,
    accountId,
  };
}

/** Is uploading available at all? Lets the UI hide the file picker rather than fail on click. */
export function uploadsConfigured(env: Env): boolean {
  try {
    config(env);
    return true;
  } catch {
    return false;
  }
}

async function presign(
  env: Env,
  key: string,
  method: 'PUT' | 'GET',
  ttlSeconds: number,
  contentType?: string,
): Promise<string> {
  const { client, bucket, accountId } = config(env);
  const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`);
  url.searchParams.set('X-Amz-Expires', String(ttlSeconds));
  // Signing the content-type binds the URL to one media type: a URL issued for a
  // PDF cannot be redirected into uploading something else. The browser must then
  // send exactly this header, which the upload code does.
  const signed = await client.sign(new Request(url, { method, headers: contentType ? { 'content-type': contentType } : {} }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

/** A URL the browser can PUT one object to, once, for the next 15 minutes. */
export const presignUpload = (env: Env, key: string, contentType: string): Promise<string> =>
  presign(env, key, 'PUT', UPLOAD_URL_TTL_SECONDS, contentType);

/** A URL the Manyfold agent can GET the object from while a pass runs. */
export const presignFetch = (env: Env, key: string): Promise<string> =>
  presign(env, key, 'GET', FETCH_URL_TTL_SECONDS);

/** Removes every object under a review. Best-effort: a failure must not block the delete. */
export async function deleteReviewObjects(env: Env, reviewId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listing = await env.DOCS.list({ prefix: reviewPrefix(reviewId), cursor });
    if (listing.objects.length > 0) {
      await env.DOCS.delete(listing.objects.map((object) => object.key));
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
}
