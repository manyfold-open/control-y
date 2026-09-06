/**
 * The two decisions the upload vocabulary makes before anything is sent: whether
 * a picked file can go in at all, and what the review it starts should be called.
 *
 * Worth testing away from the browser because both are pure and both are the
 * client half of a server rule — a drift between them shows up as a file that
 * looks accepted and is then refused, which is the exact experience the
 * client-side check exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import { rejectionFor, titleFromFileName, type UploadLimits } from './upload';

const limits: UploadLimits = { maxBytes: 10 * 1024 * 1024, uploadsEnabled: true };
const noUploads: UploadLimits = { ...limits, uploadsEnabled: false };

const file = (name: string, bytes = 12, type = ''): File =>
  new File([new Uint8Array(bytes)], name, type ? { type } : undefined);

describe('rejectionFor', () => {
  it('accepts an ordinary document', () => {
    expect(rejectionFor(file('nav-pack-june.pdf'), limits)).toBe('');
  });

  it('refuses video by extension and by media type', () => {
    expect(rejectionFor(file('walkthrough.mov'), limits)).toMatch(/not supported/);
    expect(rejectionFor(file('walkthrough.bin', 12, 'video/mp4'), limits)).toMatch(/not supported/);
  });

  it('refuses an empty file, which the server would reject as missing content', () => {
    expect(rejectionFor(file('staging.csv', 0), limits)).toBe('That file is empty.');
  });

  it('says the size and the limit when a file is too large, and offers the way through', () => {
    const rejection = rejectionFor(file('nav-pack.pdf', 11 * 1024 * 1024), limits);
    expect(rejection).toContain('11.0 MB');
    expect(rejection).toContain('10 MB');
    expect(rejection).toMatch(/Paste an extract/);
  });

  it('takes text on a deployment with no uploads configured, and nothing else', () => {
    expect(rejectionFor(file('trial-balance.csv'), noUploads)).toBe('');
    expect(rejectionFor(file('side-letter.pdf'), noUploads)).toMatch(/not configured/);
  });

  it('reads the media type when the name carries no extension', () => {
    expect(rejectionFor(file('extract', 12, 'text/plain'), noUploads)).toBe('');
  });
});

describe('titleFromFileName', () => {
  it('drops the extension and gives the separators back as spaces', () => {
    expect(titleFromFileName('Q2-2026-journal-batch.xlsx')).toBe('Q2 2026 journal batch');
    expect(titleFromFileName('nav_pack_june.pdf')).toBe('nav pack june');
  });

  it('leaves a name that is already prose alone', () => {
    expect(titleFromFileName('Meridian side letter.pdf')).toBe('Meridian side letter');
  });

  it('keeps the file name when stripping would leave nothing', () => {
    expect(titleFromFileName('.gitignore')).toBe('.gitignore');
  });

  it('collapses the runs a double extension leaves behind', () => {
    expect(titleFromFileName('trial.balance.final.csv')).toBe('trial balance final');
  });
});
