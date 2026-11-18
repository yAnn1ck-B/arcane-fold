# Foundations gameplay verification

This report covers local Play on `experiment/playtest` with Forge Desktop 2.0.13 and JDK 17. The installed Foundations (FDN) edition contains 771 printings across 517 distinct names, including the Starter Collection. Foundations Jumpstart (J25) and Special Guests (SPG) have separate set codes. The original positions and results are preserved in the checkpoint commit `b8941e8`.

## Set-wide checks

| Check | What was exercised |
| --- | --- |
| Printing and script inventory | The saved-deck loader constructed all 771 exact collector numbers. All 517 names mapped to a Forge script, and all 30 explicitly referenced token scripts were present. |
| First play for every name | 473 spells resolved and 44 lands were played. Each position used the production controller and ran through the resulting stack. Twelve cards needed a different position with suitable mana, an attacking creature or an opposing spell to respond to. |
| Activated abilities | The sweep exercised 151 activation routes across 125 cards. Forge resolved 94 abilities on the stack and recorded mana from the selected source in 57 cases. The other names comprise 276 permanents with no activation in the surveyed position and 116 instants or sorceries. Conditions included ten other untapped Elves, an attacking creature, counters on the source, a legal opposing nonbasic land and two creatures activating from their owner's graveyard. |
| Focused regressions | The inventory links 71 specific card names to 69 named tests. These check which seat gets a decision, what it can see, and what happens to the cards, stack, mana and life totals. |

Read the first-play table as an observation of one route through each card. A permanent can enter successfully while its end-step trigger, alternate activation or interaction with a second card needs its own position. The activation table records the source, cost, engine event and decisions in each position. The focused tests supply assertions about specific outcomes. Other combinations of cards, replacement effects and timing windows remain open to playtesting. [Printing, ability and test inventory](foundations-card-audit.tsv) · [First-play results](foundations-first-play.tsv) · [Activation results](foundations-activations.tsv)

## Automatic passes and priority stops

Play checks which actions the player can legally take at each priority window. A counterspell in hand becomes a reason to stop when a legal target reaches the stack. An available graveyard activation also counts. Players can respond during their own upkeep and to their own spells or triggers. In paired runs of the same two positions, Automatic and Full control offered the same nonmana decisions and reached the same resulting board.

Mana alone usually passes automatically. Play pauses for a usable mana source threatened by a direct target or an applicable mass-destruction effect. The player can tap another source first. In the Day of Judgment test, Llanowar Elves floats green before dying, Liliana draws Think Twice, and the green mana plus an Island pays for the spell that phase. An already-tapped Elf and an unaffected Island pass through the same spell. The activation sweep supplies an open priority window so the pilot can select each mana source.

**Your priority** can reserve the next priority, the next matching step on either turn, or every priority for that seat. A stop after blockers happens before combat damage. A stop after damage happens after damage has been dealt. Players can set a stop during their opening hand or from their own view while another decision is pending. The installed regressions cover seat privacy, retaining priority after producing mana or casting a spell, and reproducing stops through Undo.

Automatic priority cannot infer every reason to float mana before an untargeted effect resolves. For a planned interaction, set a stop in advance. Wizards describes a similar tradeoff in Arena, where the default shortcuts have exceptions for particular game states and players can set stops or use Full Control. [Arena's guide to smart priority](https://magic.wizards.com/en/news/mtg-arena/announcements-october-27-2025) · [Priority regressions](../src-tauri/src/play/priority_tests.rs) · [Full-control and replay tests](../src-tauri/src/play/replay.rs)

## Targeting, casting and paying costs

| Position | Verified behavior |
| --- | --- |
| Biogenic Upgrade and Chandra, Flameshaper | Players select targets and announce the amount for each before the opponent responds. Bouncing a target loses its share. Teach by Example allows new targets for a copy and preserves the corresponding amounts. |
| Bolt Bend and Burst Lightning | The player chooses a legal replacement target. If no replacement is possible, the original target stands. |
| Vizier of the Menagerie and Omniscience | Vizier shows the library's top card to the permitted seat and allows the creature to be cast with the mana it grants permission to spend. Omniscience offers a free cast with no mana available. |
| Blasphemous Edict and Muldrotha | The one-black alternate cost becomes available with thirteen creatures. Playing a land from the graveyard consumes the player's land drop. |
| Eaten Alive and Harbinger of the Tides | Eaten Alive requires the player to choose and pay its additional cost before it exiles the target. Harbinger costs two extra mana at instant timing. Its controller can accept or decline the bounce after choosing a tapped opposing creature. |
| Leyline Axe | After both players keep and finish putting mulligan cards on the bottom, each player with an Axe in hand can choose whether to start with it on the battlefield. |
| Chandra, Flameshaper and Tinybones, Bauble Burglar | Chandra lets the player choose the exiled card and the permission expires at the end of the turn. Tinybones permits an opponent-owned card in exile with a stash counter. |
| Strongbox Raider | After an attack, its controller exiles two cards and chooses one. Only that card can be played through the end of the controller's next turn. Without an attack, the cards stay in the library. |
| Etali, Primal Storm | The attacking player chooses which exiled spells to cast, their order and their targets during resolution. Burst Lightning can be cast for free for 2 damage, or kicked for four mana for 4 damage. The player can decline to cast. Lands remain in exile. |
| Thrill of Possibility and Hungry Ghoul | The payer chooses which card to discard or which other creature to sacrifice before the spell or ability resolves. |
| Lathril, Blade of the Elves | With eleven other untapped Elves, the controller chooses the ten that pay for the activation. The remaining Elf stays untapped. The opponent loses 10 life and the controller gains 10. |
| Pyromancer's Goggles | A Mountain pays for one Shock and leaves the Goggles untapped. Tapping the Goggles instead copies the spell, gives the controller the option to change its target, and deals 4 damage if both hit the opponent. |
| Wildborn Preserver and Mentor of the Meek | Wildborn's controller can decline or choose X during resolution. Paying zero or more creates a second, respondable trigger. Mentor offers its optional draw when the controller can pay one, spends the mana on acceptance and leaves it available on decline. |

[Targeting and trigger regressions](../src-tauri/src/play/target_tests.rs) · [Casting permission regressions](../src-tauri/src/play/permission_tests.rs) · [Wildborn Preserver regression](../src-tauri/src/play/variable_combo_tests.rs) · [Wizards' Foundations rulings](https://magic.wizards.com/en/news/feature/foundations-release-notes)

## Decisions, combat and board information

| Position | Verified behavior |
| --- | --- |
| Curator of Destinies and Inspiration from Beyond | Curator's controller allocates the five cards. The opponent chooses between the face-up pile and the face-down pile, seeing only the permitted information. Inspiration's controller chooses the eligible spell returned from the graveyard. |
| Sorcerous Spyglass and Heraldic Banner | Spyglass privately reveals the opponent's hand and accepts a legal printed name, including a name outside the decks. Naming Reassembling Skeleton disables its graveyard activation. Banner retains the chosen color and its bonus applies to the matching creature. |
| Perforating Artist | The opponent chooses whether to discard, sacrifice or lose 3 life. The chosen payment or life loss appears on the correct side of the table. |
| Multiple blockers and trample | The attacker can choose which one-toughness blocker takes the Elf's single damage. Rampaging Baloths can assign damage to the defending player once both blockers have been assigned lethal damage. |
| Menace and forced attacks | A lone eligible blocker passes against Nullpriest of Oblivion. Two eligible blockers can block together. A lone Juggernaut with one required attack proceeds to the defender's response window. Alternate defenders and other possible attackers stay player choices. |
| Chandra, Flameshaper and Crawling Barrens | Chandra can spend exactly her last four loyalty counters to damage an opposing planeswalker. The ability stays on the stack after Chandra dies. Crawling Barrens gains its counters whether its controller chooses to turn it into a creature or keep it a land. |
| Vivien Reid, Loot and Squad Rallier | Vivien's controller sees all four cards, can choose an eligible card or decline, and chooses the order of the cards put on the bottom. Looking at cards that miss a filter still shows those cards privately to the player. |
| Goldvein Pick and Healer's Hawk | The board identifies the equipped Hawk and its equipment. The Hawk gets the bonus, deals combat damage and creates a Treasure token. |
| Chandra's Hawk copy | The token is visibly distinct from the original. Its inspector includes haste and the sacrifice ability. It can attack immediately and leaves the battlefield at the end step. |
| Existing interactions | Separate positions cover scry, surveil, library search, flashback, Elf tokens, counters, simultaneous triggers, undo and the Bloodthirsty Conqueror loop, including interrupting that loop with Unsummon. |

[Private choices and costs](../src-tauri/src/play/decision_tests.rs) · [Library and forced-combat decisions](../src-tauri/src/play/integrity_tests.rs) · [Battlefield and combat regressions](../src-tauri/src/play/board_tests.rs) · [Lifegain combo regressions](../src-tauri/src/play/lifegain_combo_tests.rs) · [Foundations combat rules](https://magic.wizards.com/en/news/announcements/foundations-update-bulletin)

## Repeat the checks

From the repository root, set the path to Forge Desktop 2.0.13 and make `java` and `javac` from JDK 17 available. The Python checks compare the saved reports with fresh results. Omitting `--check` regenerates a report after reviewing a change to the expected behavior. The installed-engine checks use disposable games and separate Forge homes.

```powershell
$env:FORGE_BOLT_TEST_INSTALL = 'C:\path\to\Forge 2.0.13'
python scripts/audit-foundations.py "$env:FORGE_BOLT_TEST_INSTALL" --check
python scripts/check-foundations-first-play.py "$env:FORGE_BOLT_TEST_INSTALL" --check
python scripts/check-foundations-first-play.py "$env:FORGE_BOLT_TEST_INSTALL" --activations --check
npm run test:forge
npm run test:game
```
