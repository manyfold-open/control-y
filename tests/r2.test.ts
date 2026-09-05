import { describe, expect, it } from 'vitest';
import { documentKey, formatLimit, reviewPrefix, MAX_UPLOAD_BYTES } from '../src/worker/r2';
import { isLegacyBinary, readLegacyEnvelope } from '../src/worker/store';

describe('documentKey', () => {
  it('puts every document of a review under that review, so a prefix delete is exact', () => {
    const key = documentKey('r-q1-2026', 'd-abc');
    expect(key).toBe('reviews/r-q1-2026/d-abc');
    expect(key.startsWith(reviewPrefix('r-q1-2026'))).toBe(true);
  });

  it('does not let one review’s prefix match another that shares its opening', () => {
    // reviews/r-q1/ must not be a prefix of reviews/r-q1-2026/...
    expect(documentKey('r-q1-2026', 'd-abc').startsWith(reviewPrefix('r-q1'))).toBe(false);
  });
});

describe('formatLimit', () => {
  it('states the cap in megabytes, which is the unit the user picked the file in', () => {
    expect(formatLimit(MAX_UPLOAD_BYTES)).toBe('10 MB');
  });
});

describe('legacy inline files', () => {
  const envelope = (payload: string) => `control-y-file-v1:${payload}`;

  it('reads an envelope written before uploads moved to R2', () => {
    const value = readLegacyEnvelope(envelope(JSON.stringify({ content: 'QUJD', mediaType: 'application/pdf' })));
    expect(value).toEqual({ base64: 'QUJD', mediaType: 'application/pdf' });
  });

  it('falls back to octet-stream when the envelope names no media type', () => {
    expect(readLegacyEnvelope(envelope(JSON.stringify({ content: 'QUJD' })))?.mediaType).toBe(
      'application/octet-stream',
    );
  });

  it('returns null for a malformed envelope rather than throwing', () => {
    expect(readLegacyEnvelope(envelope('{not json'))).toBeNull();
    expect(readLegacyEnvelope(envelope(JSON.stringify({ mediaType: 'application/pdf' })))).toBeNull();
  });

  it('leaves ordinary pasted text alone', () => {
    expect(isLegacyBinary('row 47  SARDONYX CLOSING  632,911.04')).toBe(false);
    expect(readLegacyEnvelope('row 47  SARDONYX CLOSING')).toBeNull();
  });

  it('still recognises an envelope it cannot parse, so readDocuments can skip it', () => {
    // This is the pairing that matters: recognised as binary, unreadable as an
    // envelope. Feeding that string to a reviewer as prose would spend the
    // document budget on base64.
    const broken = envelope('{not json');
    expect(isLegacyBinary(broken)).toBe(true);
    expect(readLegacyEnvelope(broken)).toBeNull();
  });
});
