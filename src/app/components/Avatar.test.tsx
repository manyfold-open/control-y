/**
 * The two pure decisions behind an avatar: where a person's photo would be, and
 * which chip it is drawn in. Worth pinning because the path is a convention
 * rather than a stored value, so nothing else in the app would notice it drift
 * away from the filenames in public/people.
 */

import { describe, expect, it } from 'vitest';
import { avatarClass, photoSrc } from './Avatar';

describe('photoSrc', () => {
  it('names the file after the person id', () => {
    expect(photoSrc('p-roos')).toBe('/people/p-roos.svg');
  });

  it('is null without an id, so the initials stand in', () => {
    expect(photoSrc(undefined)).toBeNull();
    expect(photoSrc('')).toBeNull();
  });
});

describe('avatarClass', () => {
  it('is a plain avatar by default', () => {
    expect(avatarClass(false, false)).toBe('avatar');
  });

  it('keeps the ink ground for you, at either size', () => {
    expect(avatarClass(true, false)).toBe('avatar self');
    expect(avatarClass(true, true)).toBe('avatar self large');
  });

  it('takes the roster size without claiming to be you', () => {
    expect(avatarClass(false, true)).toBe('avatar large');
  });
});
