import { config } from '../config.js';

// Gemini REST (generateContent) with function calling. Kept behind an interface so tests use a fake model.

export interface Part {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}
export interface Content { role: 'user' | 'model'; parts: Part[] }

export interface ModelRequest { system: string; contents: Content[] }
export interface ModelResult {
  text: string | null;
  functionCall: { name: string; args: Record<string, unknown> } | null;
  usage: { input: number; output: number };
}

export interface ModelProvider { generate(req: ModelRequest): Promise<ModelResult> }

export const TOOLS = [
  {
    name: 'create_order_draft',
    description:
      "Appeler UNIQUEMENT quand le client a donné: produit + variante, nom, téléphone et adresse. Le code calcule le prix et envoie le récapitulatif.",
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              variant_id: { type: 'integer', description: 'variant_id exact du catalogue' },
              qty: { type: 'integer' },
            },
            required: ['variant_id', 'qty'],
          },
        },
        customer_name: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string', description: 'adresse ou ville/délégation de livraison' },
      },
      required: ['items', 'customer_name', 'phone', 'address'],
    },
  },
  {
    name: 'customer_confirms',
    description: 'Le client confirme le récapitulatif de commande en attente.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'customer_declines',
    description: 'Le client refuse ou annule la commande en attente.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'handoff_to_owner',
    description:
      "Passer la main au propriétaire: réclamation, négociation de prix, demande hors catalogue, client énervé, ou question à laquelle tu ne peux pas répondre avec les infos fournies.",
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
];

export class GeminiProvider implements ModelProvider {
  async generate(req: ModelRequest): Promise<ModelResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.contents,
        tools: [{ functionDeclarations: TOOLS }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
      }),
      signal: AbortSignal.timeout(config.gemini.timeoutMs),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`gemini ${res.status}: ${body?.error?.message ?? 'unknown'}`);
    const parts: Part[] = body?.candidates?.[0]?.content?.parts ?? [];
    const call = parts.find((p) => p.functionCall)?.functionCall ?? null;
    const text = parts.map((p) => p.text ?? '').join('').trim() || null;
    if (!call && !text) throw new Error(`gemini empty response (finishReason=${body?.candidates?.[0]?.finishReason})`);
    return {
      text,
      functionCall: call ? { name: call.name, args: call.args ?? {} } : null,
      usage: {
        input: body?.usageMetadata?.promptTokenCount ?? 0,
        output: body?.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}

/** Retry transient failures (timeout, 429, 5xx) twice with backoff. */
export async function generateWithRetry(p: ModelProvider, req: ModelRequest, tries = 3): Promise<ModelResult> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await p.generate(req);
    } catch (e) {
      last = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last;
}
