/**
 * One vocabulary for putting a document into a review.
 *
 * Two places take documents — the new-review dialog and a review's settings —
 * and they have to agree on what the browser accepts, what it calls the file,
 * and how the bytes reach R2. Anything they disagreed on would surface as a file
 * that can be added in one place and is refused in the other.
 *
 * The rules here are the client half of `POST /api/reviews/:id/documents` in
 * src/worker/routes.ts. They exist to refuse a bad pick at the moment it is
 * dropped, rather than after a 10 MB upload the server was always going to
 * reject. The server still checks all of it: this is courtesy, not defence.
 */

import type { Workspace } from '../shared/types';
import { send } from './api';
import { errorText, formatBytes } from './lib';

const TEXT_FILE = /\.(txt|csv|tsv|md|json|log|xml|yaml|yml|html|htm|css|js|jsx|ts|tsx|sql|rtf)$/i;
const VIDEO_FILE = /\.(3gp|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|ogv|vob|webm|wmv)$/i;

/** Mirrors DOCUMENT_MAX_CHARS in src/worker/routes.ts. */
const INLINE_MAX_CHARS = 400_000;

/** Three at a time: enough to overlap the slow part, few enough to stay polite. */
const AT_ONCE = 3;

export const isVideoFile = (file: File): boolean =>
  file.type.toLowerCase().startsWith('video/') || VIDEO_FILE.test(file.name);

export const isTextFile = (file: File): boolean =>
  file.type.toLowerCase().startsWith('text/') || TEXT_FILE.test(file.name);

export const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

export interface UploadLimits {
  maxBytes: number;
  uploadsEnabled: boolean;
}

/** The deployment's limits, or the safe assumption while the workspace is loading. */
export const limitsOf = (workspace: Workspace | null): UploadLimits => ({
  maxBytes: workspace?.maxUploadBytes ?? 10 * 1024 * 1024,
  uploadsEnabled: workspace?.uploadsEnabled ?? false,
});

/**
 * Why this file cannot go into a review, or '' if it can.
 *
 * Said in full at the moment of the drop, because the alternative is a row that
 * looks fine until the batch runs and then fails for a reason the user could
 * have been told a minute earlier.
 */
export function rejectionFor(file: File, limits: UploadLimits): string {
  if (isVideoFile(file)) return 'Video files are not supported yet.';
  if (file.size === 0) return 'That file is empty.';
  if (file.size > limits.maxBytes) {
    return `${formatBytes(file.size)}, over the ${megabytes(limits.maxBytes)} limit. Paste an extract as text instead.`;
  }
  if (!limits.uploadsEnabled && !isTextFile(file)) {
    return 'Uploads are not configured on this deployment. Paste an extract as text instead.';
  }
  return '';
}

/**
 * The name a review takes from the document it is about: the file name without
 * its extension, and with the separators a file name uses in place of spaces
 * turned back into spaces.
 *
 * A guess, and the field it fills stays editable. It is right often enough that
 * confirming it beats typing out a name the user already has in their hand.
 */
export function titleFromFileName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '');
  return stem.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

interface UploadTicket {
  documentId: string;
  uploadUrl: string;
  mediaType: string;
}

/**
 * Uploads straight to R2 with the presigned URL, so the bytes never pass through
 * the Worker. The content-type is signed into that URL, so it has to be sent back
 * exactly — anything else and R2 rejects the signature.
 */
async function putToR2(uploadUrl: string, file: File, mediaType: string): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': mediaType },
    body: file,
  });
  if (!response.ok) throw new Error(`The upload was refused (HTTP ${response.status}).`);
}

/**
 * Puts one file into a review that already exists.
 *
 * A text file becomes prompt material held inline in D1: that is what the panel
 * reads best and it costs no storage. Anything else goes to R2 and reaches the
 * panel as a link it fetches during the pass — and so does a text file too long
 * to sit in a prompt, which is a better outcome than the server refusing it.
 */
export async function addFileToReview(reviewId: string, file: File, limits: UploadLimits): Promise<void> {
  if (isTextFile(file)) {
    const content = await file.text();
    if (!content.trim()) throw new Error('That file has no text in it.');
    if (content.length <= INLINE_MAX_CHARS) {
      await send('POST', `/api/reviews/${reviewId}/documents`, { name: file.name, content });
      return;
    }
    if (!limits.uploadsEnabled) {
      throw new Error(
        `That file holds more text than a prompt can carry, and uploads are not configured on this deployment. Paste an extract instead.`,
      );
    }
  }

  const ticket = await send<UploadTicket>('POST', `/api/reviews/${reviewId}/documents/upload-url`, {
    name: file.name,
    mediaType: file.type || 'application/octet-stream',
    bytes: file.size,
  });
  await putToR2(ticket.uploadUrl, file, ticket.mediaType);
  await send('POST', `/api/reviews/${reviewId}/documents`, {
    name: file.name,
    documentId: ticket.documentId,
    mediaType: ticket.mediaType,
  });
}

/**
 * Puts a batch of files into a review, a few at a time.
 *
 * Every file settles on its own and reports through `onSettled`, so one refusal
 * leaves the rest of the batch alone: what landed is in the review already, and
 * only what did not is still the user's problem. Nothing throws — a failure is
 * an outcome for one row, not for the batch.
 */
export async function addFilesToReview(
  reviewId: string,
  files: { key: string; file: File }[],
  limits: UploadLimits,
  onSettled: (key: string, error: string) => void,
): Promise<void> {
  const queue = [...files];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await addFileToReview(reviewId, next.file, limits);
        onSettled(next.key, '');
      } catch (caught) {
        onSettled(next.key, errorText(caught));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));
}
