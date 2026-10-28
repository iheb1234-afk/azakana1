import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { instagram, verifyMetaSignature } from '../src/channels/instagram.js';
import { isBareNo, isBareYes, normalizePhone } from '../src/core/text.js';
import { decryptToken, encryptToken } from '../src/lib/crypto.js';

describe('phone', () => {
  it.each([
    ['99 643 383', '99643383'],
    ['+216 99 643 383', '99643383'],
    ['0021699643383', '99643383'],
    ['21699643383', '99643383'],
    ['99-643-383', '99643383'],
  ])('%s -> %s', (i, o) => expect(normalizePhone(i)).toBe(o));
  it.each(['9964338', '996433831', '12345678', 'abc'])('rejects %s', (i) => expect(normalizePhone(i)).toBeNull());
});

describe('bare yes / no', () => {
  it.each(['oui', 'Oui !', 'OK', 'ey', 'eyy', 'behi', "d'accord", 'نعم', 'oui 👍', 'je confirme'])('yes: %s', (t) =>
    expect(isBareYes(t)).toBe(true));
  it.each(['oui mais en 100ml', 'ok combien la livraison ?', 'non', 'salut'])('not bare yes: %s', (t) =>
    expect(isBareYes(t)).toBe(false));
  it.each(['non', 'Non merci', 'la', 'لا'])('no: %s', (t) => expect(isBareNo(t)).toBe(true));
});

describe('token encryption', () => {
  it('round-trips and is not plaintext', () => {
    const enc = encryptToken('IGAAsecret');
    expect(enc).not.toContain('IGAAsecret');
    expect(decryptToken(enc)).toBe('IGAAsecret');
  });
});

describe('instagram adapter', () => {
  const ev = (message: object, sender = 'cust1') => ({
    object: 'instagram',
    entry: [{ id: 'shopIG', messaging: [{ sender: { id: sender }, recipient: { id: 'shopIG' }, timestamp: 1, message }] }],
  });

  it('parses a text message', () => {
    const [m] = instagram.parse(ev({ mid: 'm1', text: ' 9adeh bleu chanel? ' }));
    expect(m).toMatchObject({ channel: 'instagram', accountId: 'shopIG', customerId: 'cust1', messageId: 'm1', text: '9adeh bleu chanel?' });
  });
  it('drops echoes of our own messages', () => {
    expect(instagram.parse(ev({ mid: 'm2', text: 'hi', is_echo: true }))).toHaveLength(0);
    expect(instagram.parse(ev({ mid: 'm3', text: 'hi' }, 'shopIG'))).toHaveLength(0);
  });
  it('drops read/delivery receipts (no message)', () => {
    const p = { object: 'instagram', entry: [{ id: 'shopIG', messaging: [{ sender: { id: 'c' }, recipient: { id: 'shopIG' }, timestamp: 1, read: { mid: 'x' } }] }] };
    expect(instagram.parse(p)).toHaveLength(0);
  });
  it('keeps a photo with no text', () => {
    const [m] = instagram.parse(ev({ mid: 'm4', attachments: [{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }] }));
    expect(m.text).toBeNull();
    expect(m.media).toEqual([{ url: 'https://cdn/x.jpg', type: 'image' }]);
  });
  it('verifies the X-Hub-Signature-256', () => {
    const body = Buffer.from('{"a":1}');
    const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
    expect(verifyMetaSignature(body, sig, 's3cret')).toBe(true);
    expect(verifyMetaSignature(body, sig, 'wrong')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 's3cret')).toBe(false);
  });
});
