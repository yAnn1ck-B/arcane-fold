# Foundations gameplay audit

Play can load all 771 Foundations (FDN) printings in Forge Desktop 2.0.13. Some of the 517 distinct cards still lose player choices, including choices that determine which creature dies, which card enters a hand, or whether a spell can be cast. Biogenic Upgrade can end a match with an engine error.

This audit covers the current Play working tree on `experiment/playtest`. Its set boundary is collector numbers 1–771 in the installed FDN edition, including the Starter Collection and alternate art. Foundations Jumpstart (J25) and Special Guests (SPG) have separate set codes.

| Check | Result | What it establishes |
| --- | --- | --- |
| Exact-printing deck load | 771 of 771 | Forge constructed each printing through the saved-deck loader. |
| Script inventory | 517 distinct names | Every name mapped to a card script. The inventory also located the 30 distinct token scripts explicitly referenced by those cards. |
| First play for every name | 472 spells resolved, 44 lands were played and Biogenic Upgrade raised an exception. | The sweep attempted all 517 names through the Play controller. Twelve needed a second position with suitable mana, an opposing spell or a legal target. |
| Existing regression suite | 42 installed-Forge tests and 15 manual-game/session tests passed | The index identifies 30 FDN names exercised by 27 focused native tests. The remaining 487 names have no focused test linked in the inventory. |

The script inventory counts 110 names with an explicit activated ability, 236 with a triggered ability, 56 with a token-creation operation, 18 with a discard operation, 14 with scry and six with surveil. A card can appear in several counts. Keyword-generated abilities and choices embedded in costs can follow different engine paths. Thrill of Possibility and Burglar Rat below illustrate why both paths need testing.

## Reproduced gameplay gaps

These positions ran against the installed Forge engine with the production Play controller and two human-controlled seats. The fixtures supplied the initial cards, answered the controller's prompts, and inspected the resulting zones, stack, life, or counters. The observations cover the native decisions and board data consumed by React. For missing plays, the checks also inspected the permission Forge granted and the cost it considered payable.

### Match failure and incorrect resolution

| Card | Position and expected decision | Observed result |
| --- | --- | --- |
| Biogenic Upgrade | Cast with six Forests. Select Llanowar Elves and Runeclaw Bear. Assign the three counters 1/2 or 2/1 before either player responds. | Play accepted both targets and never asked for the amounts. Forge threw a null-pointer exception looking up the first target's allocation during resolution. |
| Bolt Bend | Cast Burst Lightning targeting the other player. Respond with Bolt Bend. The caster is the only other legal damage target. | Play allowed Bolt Bend to target Burst Lightning and gave no prompt to change the damage target. The original opponent took 2 damage. |

### Legal plays missing from the action menu

| Card | Available play | Observed result |
| --- | --- | --- |
| Vizier of the Menagerie | With a Forest untapped and Llanowar Elves on top of the library, look at the Elves and cast them. | Forge granted access to the top card and an affordable cast. The board showed only the library count, and the menu only offered the Forest in hand or a pass. |
| Omniscience | With no mana available, cast Llanowar Elves from hand for free. | Forge marked the free spell affordable. Play omitted the spell. |
| Blasphemous Edict | With exactly 13 creatures on the battlefield and one untapped Swamp, cast the spell for one black mana. | Forge marked the alternate cost affordable. Play omitted the spell. |
| Muldrotha, the Gravetide | Use the turn's available land play for Evolving Wilds in the graveyard. | Forge allowed the land play. Play only offered the land in hand or a pass. |
| Chandra, Flameshaper | Activate +2 and exile three Mountains. One receives permission to be played this turn. | Forge identified a legal land play for one exiled Mountain. The next menu offered the Forest in hand or a pass. |
| Tinybones, Bauble Burglar | An opponent discards Plains to Tinybones. With a land play available, play that Plains from the opponent's exile. | The exiled Plains had its stash counter. The next menu offered the Island in hand or a pass. |

### Choices the engine made for the players

| Card or situation | Expected decision | Observed result |
| --- | --- | --- |
| Thrill of Possibility | Discard either Unsummon or Fleeting Distraction to pay the casting cost. | Forge discarded Fleeting Distraction and drew two cards without a discard prompt. |
| Hungry Ghoul | Sacrifice Healer’s Hawk or Llanowar Elves to pay the activation cost. | Forge sacrificed the Elves without asking. |
| Curator of Destinies | After it enters, its controller divides five cards into face-up and face-down piles. The opponent chooses which pile goes to the controller's hand. | Neither seat got its decision. Healer’s Hawk, Llanowar Elves and Plains went to hand. Goldvein Pick and Mountain went to the graveyard. |
| Inspiration from Beyond | Mill three Islands with Unsummon and Fleeting Distraction already in the graveyard. Choose which instant or sorcery to return. | Forge returned Unsummon without asking. |
| Heraldic Banner | Choose the color as the artifact enters. | The Banner resolved with white as its chosen color. Play sent no color prompt. |
| Sorcerous Spyglass | Look at an opponent's hand containing Soul-Guide Lantern, then choose a card name. | Spyglass named Island without asking the player for a name. |
| Combat with two blockers | Attack with 1/1 Llanowar Elves. Block with Savannah Lions and Helpful Hunter, each with 1 toughness. The attacker chooses which blocker takes the Elves' damage. | Both seats confirmed their combat declarations. Lions died, Hunter survived, and the attacker received no damage-assignment choice. |

The Foundations rulings describe the pile decisions and who may see them. The set's combat rules let the attacker assign its damage among multiple blockers. [Foundations release notes](https://magic.wizards.com/en/news/feature/foundations-release-notes) · [Foundations rules update](https://magic.wizards.com/en/news/announcements/foundations-update-bulletin)

## What to fix first

1. Capture the Biogenic Upgrade and Bolt Bend positions in permanent regressions. Check the announced targets and allocations while the spell is on the stack, then assert the counters or damage after resolution. These positions expose a match-ending error and an incorrect game outcome.
2. Build the priority menu from the plays Forge grants the seat, including alternate payments and plays from the library, graveyard or exile. Cover an unaffordable printed cost, a permitted alternate cost, a permission that expires and an opponent-owned card.
3. Route payment and resolution decisions to the responsible seat. Exercise both choices for the Hungry Ghoul sacrifice and the Thrill of Possibility discard. Curator additionally needs separate private prompts for the two players.
4. Expose combat damage assignment, equipment attachments and temporary token identity on the automatic table. Assert both the engine outcome and what each player can see on the board.

## Interactions that worked

- **Wildborn Preserver** has a regression covering decline and payments of 0, 1 and 3 as the original trigger resolves. Paying puts the separate counter trigger on the stack. The opponent can respond with Unsummon before counters are added. [Native regression](../src-tauri/src/play/variable_combo_tests.rs) · [Wizards ruling](https://magic.wizards.com/en/news/feature/throne-eldraine-release-notes-2019-09-20)
- **Teach by Example and Burst Lightning** allowed a different target for the copy. The two target prompts let each player take 2 damage, leaving both at 18 life.
- **Burglar Rat** let the affected player choose the discard when its trigger resolved. **Duress** showed the revealed hand to its caster and offered only legal discards. **Tribute to Hunger** let the affected player choose the creature to sacrifice. [Discard and sacrifice regressions](../src-tauri/src/play/discard_tests.rs)
- **Goldvein Pick and Healer’s Hawk** allowed the player to equip the Hawk while Llanowar Elves was another legal choice. The Hawk became 2/2, dealt combat damage and created a Treasure. The automatic board snapshot omitted which creature the Pick was attached to.
- **Chandra, Flameshaper and Healer’s Hawk** produced a token copy that attacked immediately and was sacrificed at the end of the turn. The automatic card inspector presented the original and the temporary copy with identical characteristics, leaving the player without a visible way to identify the temporary Hawk.
- Existing seeded regressions also check private scry and surveil ordering, discarding as an effect, flashback, Elf token creation, counter doubling, and responses that break a lifegain combo. The card inventory gives the test names for each recorded interaction. [Card inventory](foundations-card-audit.tsv)

## Reading and repeating the checks

The **card inventory** connects each FDN name and collector number to its installed Forge script, abilities, token scripts and named regression tests. Its decision-review column flags code paths worth exercising. A blank cell means the script scan found no matching pattern. [Card inventory](foundations-card-audit.tsv)

The **first-play sweep** starts a fresh game for each distinct name with a fixed board, known mana and sample targets. If the card was unavailable in the first main phase, it repeats the attempt with suitable mana, a legal target, an incoming attacker or an opposing spell on the stack. The report records Forge's resolution or land-play event and identifies the second position where one was needed. A successful resolution can still skip a player decision. Bolt Bend resolved in the sweep, and the separate Burst Lightning position showed that it could leave the wrong target in place. [First-play results](foundations-first-play.tsv) · [Sweep fixture](../src-tauri/test-fixtures/FoundationsFirstPlay.java)

From the repository root, set the Forge installation path and use JDK 17 with `java` and `javac` on the path. The commands below check the two saved reports and run the Forge and manual-game regression suites. The sweep's `--check` compares observed outcomes with the audit, including the known Biogenic Upgrade failure. After a fix, inspect the new outcome and regenerate the report by omitting `--check`.

```powershell
$env:FORGE_BOLT_TEST_INSTALL = 'C:\path\to\Forge 2.0.13'
python scripts/audit-foundations.py "$env:FORGE_BOLT_TEST_INSTALL" --check
python scripts/check-foundations-first-play.py "$env:FORGE_BOLT_TEST_INSTALL" --check
npm run test:forge
npm run test:game
```
