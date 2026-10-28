-- Demo shop for local testing (perfume, like the pilot). Replace with real data.
-- The channel row is created by `npm run add-channel` so the token gets encrypted.

INSERT INTO shops (name, system_prompt, delivery_rules)
VALUES (
  'Demo Parfums',
  'Boutique de parfums à Tunis. Ton chaleureux et court. Paiement à la livraison. Retour accepté sous 3 jours si non ouvert.',
  '{"fee": 7, "zones": "Toute la Tunisie", "delay": "24 à 48h"}'
);

INSERT INTO products (shop_id, name, description, price) VALUES
  (1, 'Bleu de Chanel', 'Eau de parfum homme, boisé aromatique', 95),
  (1, 'Sauvage Dior',   'Eau de toilette homme, frais épicé',   85),
  (1, 'La Vie Est Belle', 'Eau de parfum femme, gourmand',      90);

INSERT INTO variants (product_id, label, price_override, stock_qty) VALUES
  (1, '50ml',  NULL, 5),
  (1, '100ml', 140,  2),
  (2, '60ml',  NULL, 0),   -- out of stock on purpose (test set)
  (2, '100ml', 120,  1),   -- last item (concurrency test)
  (3, '50ml',  NULL, 3);
