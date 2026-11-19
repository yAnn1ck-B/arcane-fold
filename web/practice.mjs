// Loaner decks are available for practice without changing league ownership.
const deck = (id, name, lines) => ({ id, name, text: '[Main]\n' + lines.join('\n') + '\n' });
export const practiceDecks = [
  deck('practice-elves', 'Foundations practice · Elves', [
    '12 Forest|FDN', '4 Llanowar Elves|FDN', "4 Dwynen's Elite|FDN",
    '4 Elvish Archdruid|FDN', '4 Giant Growth|FDN', '2 Imperious Perfect|FDN',
  ]),
  deck('practice-fire', 'Foundations practice · Burn', [
    '12 Mountain|FDN', '4 Burst Lightning|FDN', '4 Goblin Boarders|FDN',
    '4 Shivan Dragon|FDN', '4 Goblin Surprise|FDN', '2 Abrade|FDN',
  ]),
];
