import { decodePriority } from './priority.mjs';

// Stored checkpoints and action IDs use stable engine seats. Translate only
// the display fields of the projection already authorized for this viewer.
export function seatText(text, names, addressedSeat) {
  if (typeof text !== 'string') return text;
  const waiting = /^Waiting for (?:your opponent|opponent|Player ([12]))[.…]*$/i.exec(text);
  if (waiting) {
    const other = addressedSeat === 'player' ? 'opponent' : 'player';
    const seat = waiting[1] ? (waiting[1] === '1' ? 'player' : 'opponent') : addressedSeat && other;
    return seat ? `Waiting for ${names[seat]}…` : 'Waiting for an opponent…';
  }
  const zones = /\b(your opponent['’]s|your) (hand|graveyard|library|battlefield|exile|command zone)\b/gi;
  const withZones = addressedSeat ? text.replace(zones, (_, owner, zone) => {
    const other = addressedSeat === 'player' ? 'opponent' : 'player';
    return names[owner.toLowerCase() === 'your' ? addressedSeat : other] + "'s " + zone;
  }) : text;
  return withZones.replace(/\bPlayer ([12])\b/g, (_, number) => names[number === '1' ? 'player' : 'opponent']);
}

export function displayPosition(state, names, seat) {
  if (!state) return state;
  const label = text => seatText(text, names);
  const prompt = text => seatText(text, names, seat);
  const history = state.history?.map(entry => ({...entry, text:label(entry.text)}));
  if (state.mode === 'manual') {
    const view = state.view;
    const handoff = view.handoffDecision;
    const players = view.players.map((player, index) => {
      // The bridge uses these exact deck names as placeholders. Other deck
      // names, token names, catalog text and combat IDs belong to the game.
      return player.deckName === 'Player ' + (index + 1)
        ? {...player, deckName:names[index === 0 ? 'player' : 'opponent']} : player;
    });
    return {...state, history, view:{...view, players,
      stack:view.stack.map(item => ({...item, label:label(item.label), targets:label(item.targets),
        ...(item.description && {description:label(item.description)})})),
      ...(handoff && {handoffDecision:{...handoff, text:prompt(handoff.text), choices:handoff.choices.map(prompt)}}),
    }};
  }
  return {...state, history, prompt:prompt(state.prompt),
    ...(state.priorityStop && {priorityStop:decodePriority(state.priorityStop)}),
    choices:state.choices?.map(choice => ({...choice, label:choice.kind === 'card' ? prompt(choice.label) : label(choice.label)})),
    stack:state.stack?.map(card => ({...card, ...(card.target && {target:label(card.target)}),
      ...(card.description && {description:label(card.description)})})),
    ...(state.librarySearch && {librarySearch:{...state.librarySearch, title:prompt(state.librarySearch.title)}}),
  };
}
