import { config } from '../config.js';

// WhatsApp Cloud API, business-initiated = approved TEMPLATE messages (paid "utility" category).
// Templates to create in WhatsApp Manager (category Utility, language fr), exact names below:
//   azk_new_order : "Nouvelle commande #{{1}} : {{2}}. Total {{3}}. Ouvrez Azakana pour la préparer."
//   azk_attention : "Azakana : {{1}}. Ouvrez la conversation avec le client {{2}}."
// Template parameters can't contain line breaks or tabs, so values are flattened.

export const whatsappEnabled = () => !!(config.whatsapp.token && config.whatsapp.phoneNumberId);

const flat = (s: string) => s.replace(/[\n\t]+/g, ' · ').replace(/ {4,}/g, ' ').slice(0, 900);

export async function sendTemplate(toLocal8: string, template: string, params: string[]): Promise<void> {
  const url = `${config.meta.fbGraphUrl}/${config.meta.fbApiVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.whatsapp.token}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: `216${toLocal8}`,
      type: 'template',
      template: {
        name: template,
        language: { code: config.whatsapp.templateLang },
        components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: flat(p) })) }],
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`whatsapp ${res.status}: ${body.error?.message ?? 'unknown'}`);
  }
}
