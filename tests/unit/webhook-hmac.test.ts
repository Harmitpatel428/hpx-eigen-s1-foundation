import * as crypto from 'crypto';
import { verifyWebhookSignature } from '../../src/routes/whatsapp.router';

const SECRET = 'test-webhook-secret';
const BODY = Buffer.from(JSON.stringify({ externalId: 'x', from: '+15550001', to: '+15550002', body: 'hi' }));
const TAMPERED = Buffer.from(JSON.stringify({ externalId: 'x', from: '+15550001', to: '+15550002', body: 'EVIL' }));

function sign(body: Buffer, tsSec: number, secret = SECRET): Record<string, string> {
  const sig = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${tsSec}.`), body])).digest('hex');
  return { 'x-webhook-timestamp': String(tsSec), 'x-webhook-signature': sig };
}

describe('verifyWebhookSignature', () => {
  it('accepts a valid fresh signature', () => {
    const now = Date.now();
    const h = sign(BODY, Math.floor(now / 1000));
    expect(verifyWebhookSignature(BODY, h['x-webhook-timestamp'], h['x-webhook-signature'], SECRET, now)).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const now = Date.now();
    const h = sign(TAMPERED, Math.floor(now / 1000));
    expect(verifyWebhookSignature(BODY, h['x-webhook-timestamp'], h['x-webhook-signature'], SECRET, now)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects signatures older than the replay window', () => {
    const tenMinutesAgo = Math.floor((Date.now() - 600_000) / 1000);
    const h = sign(BODY, tenMinutesAgo);
    expect(verifyWebhookSignature(BODY, h['x-webhook-timestamp'], h['x-webhook-signature'], SECRET)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('rejects missing headers/body', () => {
    expect(verifyWebhookSignature(BODY, undefined, undefined, SECRET)).toEqual({ ok: false, reason: 'missing_signature' });
    expect(verifyWebhookSignature(undefined, '1', 'ab', SECRET)).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects when secret is unconfigured or wrong (fail closed)', () => {
    const h = sign(BODY, Math.floor(Date.now() / 1000));
    expect(verifyWebhookSignature(BODY, h['x-webhook-timestamp'], h['x-webhook-signature'], undefined)).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
    expect(verifyWebhookSignature(BODY, h['x-webhook-timestamp'], h['x-webhook-signature'], 'other-secret')).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });
});
