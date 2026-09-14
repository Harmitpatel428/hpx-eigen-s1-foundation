import { describe, it, expect } from '@jest/globals';
import { matchesMagicBytes } from '../../src/domain/mandate';

describe('matchesMagicBytes', () => {
  it('accepts a valid PDF (%PDF-)', () => {
    const pdf = Buffer.from('%PDF-1.7 fake content');
    expect(matchesMagicBytes('application/pdf', pdf)).toBe(true);
  });

  it('accepts a valid JPEG (FF D8 FF)', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(matchesMagicBytes('image/jpeg', jpeg)).toBe(true);
  });

  it('accepts a valid PNG (89 50 4E 47)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(matchesMagicBytes('image/png', png)).toBe(true);
  });

  it('rejects an exe renamed to .pdf', () => {
    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]); // MZ header
    expect(matchesMagicBytes('application/pdf', exe)).toBe(false);
  });

  it('rejects random bytes claimed as image/jpeg', () => {
    const garbage = Buffer.from('This is not a JPEG');
    expect(matchesMagicBytes('image/jpeg', garbage)).toBe(false);
  });

  it('rejects a PNG header claimed as application/pdf', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(matchesMagicBytes('application/pdf', png)).toBe(false);
  });

  it('rejects an unknown content type', () => {
    const html = Buffer.from('<html>');
    expect(matchesMagicBytes('text/html', html)).toBe(false);
  });

  it('rejects a buffer too short for the signature', () => {
    const tiny = Buffer.from([0x25, 0x50]); // only 2 bytes of %PDF-
    expect(matchesMagicBytes('application/pdf', tiny)).toBe(false);
  });

  it('rejects an empty buffer', () => {
    expect(matchesMagicBytes('application/pdf', Buffer.alloc(0))).toBe(false);
  });
});
