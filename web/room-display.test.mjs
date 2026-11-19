import assert from 'node:assert/strict';
import test from 'node:test';
import { displayPosition, seatText } from './room-display.mjs';

const names = { player:'Yannick', opponent:'Jef' };

test('saved Forge projections show names in prompts, history, choices and targets while retaining engine identifiers', () => {
  const card = {name:'Serra Angel', oracleText:'Return target creature to your hand.', id:'c1'};
  const saved = {actor:'opponent', prompt:"Choose a card from Player 1's hand to return to your library",
    choices:[{id:'p1',seat:'player',kind:'target',label:'Target Player 1',cardId:card.id}],
    history:[{turn:1,text:'Player 1 attacked Player 2.'}],
    librarySearch:{title:"Look at your opponent's library",cards:[card]},
    players:{player:{hand:[]},opponent:{hand:[card]}}, stack:[{...card, target:'Player 2 (2)',description:'Player 1 pays.'}]};
  const original = structuredClone(saved);
  const shown = displayPosition(saved,names,'opponent');
  assert.equal(shown.prompt,"Choose a card from Yannick's hand to return to Jef's library");
  assert.equal(shown.history[0].text,'Yannick attacked Jef.');
  assert.deepEqual(shown.choices,[{...saved.choices[0],label:'Target Yannick'}]);
  assert.equal(shown.librarySearch.title,"Look at Yannick's library");
  assert.deepEqual(shown.librarySearch.cards,saved.librarySearch.cards);
  assert.deepEqual(shown.players,saved.players);
  assert.equal(shown.stack[0].target,'Jef (2)');
  assert.equal(shown.stack[0].description,'Yannick pays.');
  assert.equal(shown.stack[0].oracleText,card.oracleText);
  assert.deepEqual(saved,original);
  assert.equal(seatText('Waiting for your opponent.',names,'opponent'),'Waiting for Yannick…');
  assert.equal(seatText('Waiting for Player 2',names),'Waiting for Jef…');
  assert.equal(seatText('Waiting for opponent…',names,'player'),'Waiting for Jef…');
  assert.equal(seatText('Target player draws two cards.',names),'Target player draws two cards.');
});

test('manual projected labels use names and retain private data boundaries and custom deck names', () => {
  const saved = {mode:'manual', actor:'player', history:[], view:{
    players:[{deckName:'My Player 1 test deck',zones:{hand:['my-card']}},{deckName:'Player 2',zones:{hand:[]}}],
    stack:[{id:'stack-1', controller:1, label:'Player 2 activated an ability',targets:"A card in Player 1's hand"}],
    handoffDecision:{seat:0,text:"Choose a card from Player 2's hand",choices:['Give it to Player 1']},
  }};
  const shown = displayPosition(saved,names,'player');
  assert.deepEqual(shown.view.players[0],saved.view.players[0]);
  assert.deepEqual(shown.view.players[1],{deckName:'Jef',zones:{hand:[]}});
  assert.deepEqual(shown.view.stack[0],{id:'stack-1',controller:1,label:'Jef activated an ability',targets:"A card in Yannick's hand"});
  assert.deepEqual(shown.view.handoffDecision,{seat:0,text:"Choose a card from Jef's hand",choices:['Give it to Yannick']});
});
