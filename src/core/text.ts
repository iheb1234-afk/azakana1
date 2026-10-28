// Small deterministic helpers. Hard rules live in code, not in the prompt.

/** Tunisian phone: 8 digits, optional +216 / 00216. "99 643 383" -> "99643383". Returns null if invalid. */
export function normalizePhone(input: string): string | null {
  let d = input.replace(/[^\d+]/g, '');
  if (d.startsWith('+216')) d = d.slice(4);
  else if (d.startsWith('00216')) d = d.slice(5);
  else if (d.length === 11 && d.startsWith('216')) d = d.slice(3);
  if (!/^\d{8}$/.test(d)) return null;
  // Tunisian mobile/fixed numbers start with 2,3,4,5,7,9
  if (!/^[234579]/.test(d)) return null;
  return d;
}

function clean(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')    // strip accents
    .replace(/[!?.,;:\s👍🙏❤️✅]+/gu, ' ')
    .trim();
}

// French, Tunisian Latin-script (derja), Arabic script
const YES = new Set([
  'oui', 'ouii', 'ouiii', 'wi', 'ok', 'okay', 'oki', 'dac', 'daccord', "d'accord", 'd accord', 'confirme', 'je confirme',
  'c bon', 'cest bon', "c'est bon", 'parfait', 'yes', 'ey', 'eyy', 'eyh', 'ih', 'ihi', 'aya', 'ay', 'behi', 'mriguel',
  'nconfirmi', 'confirmi', 'oui confirme', 'oui je confirme', 'نعم', 'ايه', 'إيه', 'اي', 'باهي', 'اوكي', 'موافق',
]);
const NO = new Set([
  'non', 'nn', 'no', 'nope', 'la', 'le', 'lee', 'non merci', 'annule', 'annuler', 'lela', 'لا', 'لالا', 'نلغي',
]);

/** Bare confirmation: the whole message is a yes word. "oui mais en 100ml" is NOT bare. */
export function isBareYes(text: string | null): boolean {
  return !!text && YES.has(clean(text));
}

export function isBareNo(text: string | null): boolean {
  return !!text && NO.has(clean(text));
}

export function formatTnd(n: number): string {
  return `${Number(n.toFixed(3))} DT`;
}
