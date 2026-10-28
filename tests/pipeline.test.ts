// Test set from Technical Plan section 8, replayed against a real Postgres with a fake model and fake channels.
import fs from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { registerAdapter } from '../src/channels/registry.js';
import { encryptToken } from '../src/lib/crypto.js';
import { ingest, processConversation, setDebounce, setModel, sweep } from '../src/core/pipeline.js';
import type { ModelProvider, ModelRequest, ModelResult } from '../src/core/ai.js';
import type { Channel, ChannelAdapter, NormalizedMessage } from '../src/types.js';

// ---------- fakes ----------
const sent: { channel: Channel; to: string; text: string }[] = [];
let failSends = 0;
function fakeAdapter(channel: Channel): ChannelAdapter {
  return {
    channel,
    limits: { maxTextLength: 1000, replyWindowHours: 24 },
    verifySignature: () => true,
    parse: () => [],
    async sendText(_ctx, to, text) {
      if (failSends > 0) { failSends--; throw new Error('network down'); }
      sent.push({ channel, to, text });
      return `out-${sent.length}`;
    },
  };
}
registerAdapter(fakeAdapter('test'));
registerAdapter(fakeAdapter('facebook'));

type Script = (req: ModelRequest) => Partial<ModelResult> | Error;
let script: Script[] = [];
const calls: ModelRequest[] = [];
const fakeModel: ModelProvider = {
  async generate(req) {
    calls.push(JSON.parse(JSON.stringify(req)));
    const step = script.shift();
    if (!step) throw new Error('fake model: no scripted response');
    const r = step(req);
    if (r instanceof Error) throw r;
    return { text: null, functionCall: null, usage: { input: 100, output: 20 }, ...r };
  },
};
const say = (text: string): Script => () => ({ text });
const call = (name: string, args: Record<string, unknown> = {}): Script => () => ({ functionCall: { name, args } });

// ---------- db reset ----------
async function reset() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query(fs.readFileSync('db/migrations/001_init.sql', 'utf8'));
  await pool.query(fs.readFileSync('db/seed.sql', 'utf8'));
  await pool.query(
    `INSERT INTO shop_channels (shop_id, channel, external_account_id, access_token_enc) VALUES
       (1,'test','shopacc',$1), (1,'facebook','shoppage',$1)`,
    [encryptToken('tok')],
  );
}

let n = 0;
const msg = (text: string | null, over: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  channel: 'test', accountId: 'shopacc', customerId: 'cust1', messageId: `mid-${++n}`,
  text, media: [], timestamp: Date.now() + n, ...over,
});

/** Customer sends a message and the bot handles it. Returns the bot's replies. */
async function send(text: string | null, over: Partial<NormalizedMessage> = {}) {
  const before = sent.length;
  const conv = await ingest(msg(text, over));
  if (conv) await processConversation(conv);
  return sent.slice(before).map((s) => s.text);
}
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const stock = async (variantId: number) => (await q('SELECT stock_qty FROM variants WHERE id=$1', [variantId]))[0].stock_qty;

const ORDER = { items: [{ variant_id: 1, qty: 1 }], customer_name: 'Iheb Attia', phone: '99 643 383', address: 'Ben Arous' };

beforeEach(async () => {
  await reset();
  sent.length = 0; calls.length = 0; script = []; failSends = 0;
  setModel(fakeModel);
  setDebounce(-1);
});
afterAll(() => pool.end());

// ---------- the test set ----------
describe('test set (plan §8)', () => {
  it('normal price question: model sees catalog with DB prices', async () => {
    script = [say('Bleu de Chanel 50ml est à 95 DT 😊')];
    expect(await send('9adeh bleu chanel?')).toEqual(['Bleu de Chanel 50ml est à 95 DT 😊']);
    expect(calls[0].system).toContain('variant_id=1 | Bleu de Chanel 50ml | 95 DT | in_stock=true');
    expect(calls[0].system).toContain('in_stock=false'); // Sauvage 60ml
  });

  it('full order in Latin-script derja: recap by code, bare "oui" confirms without the model, stock -1', async () => {
    script = [call('create_order_draft', ORDER)];
    const [recap] = await send('aady commande bleu chanel 50ml esmy iheb attia, 99 643 383, ben arous');
    expect(recap).toContain('1 × Bleu de Chanel 50ml: 95 DT');
    expect(recap).toContain('Livraison: 7 DT');
    expect(recap).toContain('Total: 102 DT');
    expect(recap).toContain('99643383'); // phone normalized

    const [ok] = await send('oui');
    expect(ok).toContain('Commande confirmée');
    expect(calls).toHaveLength(1); // "oui" never reached the model
    expect(await stock(1)).toBe(4);
    const [o] = await q('SELECT status, total FROM orders');
    expect(o).toEqual({ status: 'confirmed', total: 102 });
  });

  it('same webhook delivered twice: one reply', async () => {
    script = [say('Salut !')];
    const m = msg('salut');
    const c1 = await ingest(m);
    const c2 = await ingest({ ...m });
    expect(c2).toBeNull();
    await processConversation(c1!);
    expect(sent).toHaveLength(1);
    expect(await q('SELECT count(*)::int AS n FROM messages WHERE direction=$1', ['in'])).toEqual([{ n: 1 }]);
  });

  it('bare "non" after the recap cancels, no stock change', async () => {
    script = [call('create_order_draft', ORDER)];
    await send('je veux bleu chanel 50ml, Iheb Attia 99643383 Ben Arous');
    const [r] = await send('non');
    expect(r).toContain('annulée');
    expect((await q('SELECT status FROM orders'))[0].status).toBe('cancelled');
    expect(await stock(1)).toBe(5);
  });

  it('bare "oui" with NO pending order: goes to the model, and customer_confirms is refused by code', async () => {
    script = [call('customer_confirms'), say('Vous souhaitez commander quel produit ?')];
    const [r] = await send('oui');
    expect(r).toBe('Vous souhaitez commander quel produit ?');
    expect(calls[1].contents.at(-1)!.parts[0].functionResponse!.response.error).toMatch(/Aucune commande/);
    expect(await q('SELECT * FROM orders')).toHaveLength(0);
  });

  it('two messages within a second: handled as one turn, one reply', async () => {
    script = [say('Oui, 95 DT !')];
    const c = await ingest(msg('salut'));
    await ingest(msg('bleu chanel dispo?'));
    await processConversation(c!);
    expect(sent).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].contents.at(-1)!.parts[0].text).toBe('salut\nbleu chanel dispo?');
  });

  it('out-of-stock product: draft refused, model told why', async () => {
    script = [
      call('create_order_draft', { ...ORDER, items: [{ variant_id: 3, qty: 1 }] }),
      say('Désolé, Sauvage 60ml est épuisé. Le 100ml est dispo à 120 DT.'),
    ];
    const [r] = await send('sauvage 60ml, Iheb 99643383 Tunis');
    expect(r).toContain('épuisé');
    expect(await q('SELECT * FROM orders')).toHaveLength(0);
  });

  it('wrong variant id / invalid phone: refused by code', async () => {
    script = [
      call('create_order_draft', { ...ORDER, items: [{ variant_id: 999, qty: 1 }] }),
      call('create_order_draft', { ...ORDER, phone: '123' }),
      say('Quelle taille et quel numéro ?'),
    ];
    await send('commande');
    expect(calls[1].contents.at(-1)!.parts[0].functionResponse!.response.error).toMatch(/n'existe pas/);
    expect(calls[2].contents.at(-1)!.parts[0].functionResponse!.response.error).toMatch(/téléphone invalide/);
    expect(await q('SELECT * FROM orders')).toHaveLength(0);
  });

  it('two customers order the LAST item at the same moment: exactly one wins', async () => {
    const last = { ...ORDER, items: [{ variant_id: 4, qty: 1 }] }; // Sauvage 100ml, stock 1
    script = [call('create_order_draft', last), call('create_order_draft', { ...last, customer_name: 'Sami Ben Ali' })];
    await send('sauvage 100ml', { customerId: 'A' });
    await send('sauvage 100ml', { customerId: 'B' });
    expect((await q(`SELECT count(*)::int n FROM orders WHERE status='awaiting_confirmation'`))[0].n).toBe(2);

    const before = sent.length;
    const [ca, cb] = await Promise.all([ingest(msg('oui', { customerId: 'A' })), ingest(msg('oui', { customerId: 'B' }))]);
    await Promise.all([processConversation(ca!), processConversation(cb!)]);
    const replies = sent.slice(before).map((s) => s.text);
    expect(replies.filter((r) => r.includes('Commande confirmée'))).toHaveLength(1);
    expect(replies.filter((r) => r.includes('épuisé'))).toHaveLength(1);
    expect(await stock(4)).toBe(0);
  });

  it('stock sold out between recap and "oui" (owner sold it in store)', async () => {
    script = [call('create_order_draft', ORDER)];
    await send('bleu chanel 50ml Iheb 99643383 Ben Arous');
    await pool.query('UPDATE variants SET stock_qty = 0 WHERE id = 1');
    const [r] = await send('oui');
    expect(r).toContain('épuisé');
    expect((await q('SELECT status FROM orders'))[0].status).toBe('cancelled');
  });

  it('photo with no text: polite reply, conversation flagged, model not called', async () => {
    const [r] = await send(null, { media: [{ url: 'http://127.0.0.1:1/x.jpg', type: 'image' }] });
    expect(r).toContain('photo');
    expect(calls).toHaveLength(0);
    expect((await q('SELECT needs_attention FROM conversations'))[0].needs_attention).toBe(true);
  });

  it('owner takes over mid-conversation: bot stays silent', async () => {
    script = [say('Salut')];
    await send('salut');
    await pool.query('UPDATE conversations SET bot_paused = TRUE');
    expect(await send('tu es là ?')).toEqual([]);
    expect((await q(`SELECT status FROM messages WHERE text='tu es là ?'`))[0].status).toBe('skipped');
  });

  it('Gemini error/timeout: fallback message, flagged', async () => {
    script = [() => new Error('timeout'), () => new Error('timeout'), () => new Error('timeout')];
    const [r] = await send('salut');
    expect(r).toContain("Un membre de l'équipe");
    expect((await q('SELECT needs_attention FROM conversations'))[0].needs_attention).toBe(true);
  });

  it('server crash after the dedupe insert: sweeper answers it', async () => {
    script = [say('Bonjour !')];
    await ingest(msg('bonjour'));                                   // inserted, never processed (crash)
    await pool.query(`UPDATE messages SET status='processing', updated_at = now() - interval '10 minutes'`);
    expect(await sweep()).toBe(1);
    expect(sent.map((s) => s.text)).toEqual(['Bonjour !']);
  });

  it('send fails once: reply kept and re-sent by the sweeper, model not re-run', async () => {
    script = [say('Bonjour !')];
    failSends = 1;
    await send('bonjour');
    expect(sent).toHaveLength(0);
    await sweep();
    expect(sent.map((s) => s.text)).toEqual(['Bonjour !']);
    expect(calls).toHaveLength(1);
  });

  it('same person on Instagram and Facebook: two separate conversations', async () => {
    script = [say('a'), say('b')];
    await send('salut', { customerId: 'p1' });
    await send('salut', { channel: 'facebook', accountId: 'shoppage', customerId: 'p1' });
    expect(await q('SELECT channel FROM conversations ORDER BY id')).toEqual([{ channel: 'test' }, { channel: 'facebook' }]);
    expect(sent.map((s) => s.channel)).toEqual(['test', 'facebook']);
  });

  it('unknown receiving account is ignored', async () => {
    expect(await ingest(msg('hi', { accountId: 'nobody' }))).toBeNull();
  });

  it('AI usage recorded per shop (unit economics)', async () => {
    script = [say('x')];
    await send('salut');
    expect(await q('SELECT calls, input_tokens, output_tokens FROM ai_usage')).toEqual([
      { calls: 1, input_tokens: 100, output_tokens: 20 },
    ]);
  });
});
