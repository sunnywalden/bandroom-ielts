// Machine labels are ARPAbet; the UI displays American IPA. Unknown labels are
// shown unchanged rather than guessed.
const IPA: Record<string,string> = {
  AA:'ɑ', AE:'æ', AH:'ə', AO:'ɔ', AW:'aʊ', AY:'aɪ', ER:'ɝ', EY:'eɪ',
  IH:'ɪ', IY:'i', OW:'oʊ', OY:'ɔɪ', UH:'ʊ', UW:'u',
  B:'b', CH:'tʃ', D:'d', DH:'ð', F:'f', G:'ɡ', HH:'h', JH:'dʒ', K:'k',
  L:'l', M:'m', N:'n', NG:'ŋ', P:'p', R:'ɹ', S:'s', SH:'ʃ', T:'t',
  TH:'θ', V:'v', W:'w', Y:'j', Z:'z', ZH:'ʒ',
};

export function displayPhone(phone: string) {
  if (!phone || phone === '∅') return '∅';
  const match = /^([A-Z]+)[012]$/.exec(phone);
  const base = match ? match[1] : phone;
  return IPA[base] ?? phone;
}
