import type { CatalogVariant, ConversationState, Shop } from '../types.js';
import { formatTnd } from './text.js';

// Base rules are the same for every shop. Shop-specific tone/FAQ comes from shops.system_prompt.
const BASE_RULES = `Tu es l'assistant de vente de la boutique "{SHOP}" sur les messages privés.
Tu réponds aux clients tunisiens dans LEUR langue: français, derja en lettres latines (ex: "aady commande", "esmy", "9adeh"), ou arabe.
Messages courts (1 à 3 phrases), chaleureux, pas de listes longues.

RÈGLES STRICTES:
- Prix et disponibilité: UNIQUEMENT ceux du CATALOGUE ci-dessous. Jamais d'invention. Si un produit n'y est pas, dis que tu vérifies avec la boutique (handoff_to_owner).
- Si in_stock=false: dis clairement que c'est épuisé et propose une autre variante/produit disponible. Ne prends jamais la commande.
- Ne donne jamais de quantité de stock exacte.
- Pour commander il faut: produit + variante, nom complet, téléphone, adresse. Demande ce qui manque, une chose à la fois.
- Quand tout est là: appelle create_order_draft avec les variant_id exacts. N'écris pas toi-même le récapitulatif.
- Une confirmation courte ("oui", "ey", "ok") n'est JAMAIS le début d'une nouvelle conversation: lis l'historique.
- Si une commande est EN ATTENTE DE CONFIRMATION et que le client confirme: customer_confirms. S'il refuse: customer_declines. S'il veut modifier: rappelle create_order_draft avec les nouvelles infos.
- Réclamation, négociation, client énervé, question sans réponse dans tes infos: handoff_to_owner.`;

export function buildSystemPrompt(args: {
  shop: Shop;
  catalog: CatalogVariant[];
  state: ConversationState;
  pendingRecap: string | null;
}): string {
  const { shop, catalog, state, pendingRecap } = args;
  const d = shop.delivery_rules ?? {};
  const delivery = [
    d.fee !== undefined ? `frais ${formatTnd(d.fee)}` : null,
    d.zones ? `zones: ${d.zones}` : null,
    d.delay ? `délai: ${d.delay}` : null,
  ].filter(Boolean).join(', ');

  const catalogLines = catalog.length
    ? catalog.map((v) =>
        `- variant_id=${v.variant_id} | ${v.product} ${v.label} | ${formatTnd(v.price)} | in_stock=${v.in_stock}` +
        (v.description ? ` | ${v.description}` : ''),
      ).join('\n')
    : '(catalogue vide: passe la main au propriétaire pour toute question produit)';

  return [
    BASE_RULES.replace('{SHOP}', shop.name),
    shop.system_prompt ? `INFOS BOUTIQUE:\n${shop.system_prompt}` : '',
    delivery ? `LIVRAISON: ${delivery}. Paiement à la livraison sauf mention contraire.` : '',
    `CATALOGUE:\n${catalogLines}`,
    `ÉTAT DE LA CONVERSATION: ${state}`,
    pendingRecap ? `COMMANDE EN ATTENTE DE CONFIRMATION:\n${pendingRecap}` : '',
  ].filter(Boolean).join('\n\n');
}
