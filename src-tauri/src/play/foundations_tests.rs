use super::tests::{choose, play_until, practice_engine, seeded_deck, zone};
use super::{seat_view, Engine, Scenario, Seat};
use std::collections::HashSet;
use std::fmt::Write;
use std::sync::atomic::AtomicBool;

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_dwynens_elite_rechecks_for_another_elf_on_resolution() {
    for unsummon in [false, true] {
        let mut game = seeded_deck(
            "[Main]\n6 Forest|FDN\n3 Llanowar Elves|FDN|[227]\n3 Dwynen's Elite|FDN|[218]",
            Some("[Main]\n8 Island|FDN\n4 Unsummon|FDN|[599]"),
            19,
        );
        let setup = [
            "Keep hand",
            "Play Forest",
            "Play Island",
            "No attacks",
            "Pass priority",
        ];
        for spell in ["Cast Llanowar Elves", "Cast Dwynen's Elite"] {
            play_until(&mut game, spell, &setup);
            choose(&mut game, spell);
        }
        // Let the creature resolve, then give Player 2 priority with its
        // distinct triggered ability on the stack.
        assert_eq!(game.current["stack"][0]["name"], "Dwynen's Elite");
        choose(&mut game, "Pass priority");
        assert_eq!(game.current["actor"], "opponent");
        assert_eq!(game.current["stack"][0]["name"], "Dwynen's Elite");
        assert!(game.current["stack"][0]["description"].as_str().is_some());
        assert!(zone(&game, "player", "battlefield")
            .iter()
            .any(|card| card["name"] == "Dwynen's Elite"));
        if unsummon {
            choose(&mut game, "Cast Unsummon");
            choose(&mut game, "Target Llanowar Elves");
        }
        for _ in 0..6 {
            if game.current["stack"].as_array().unwrap().is_empty() {
                break;
            }
            choose(&mut game, "Pass priority");
        }
        assert!(game.current["stack"].as_array().unwrap().is_empty());
        let battlefield = zone(&game, "player", "battlefield");
        let elves: Vec<_> = battlefield
            .iter()
            .filter(|card| card["name"] == "Elf Warrior Token")
            .collect();
        assert_eq!(elves.len(), usize::from(!unsummon), "{battlefield:?}");
        assert!(!zone(&game, "opponent", "battlefield")
            .iter()
            .any(|card| card["name"] == "Elf Warrior Token"));
        if let Some(token) = elves.first() {
            assert!(token["typeLine"].as_str().unwrap().contains("Elf Warrior"));
            assert_eq!(token["power"], 1);
            assert_eq!(token["toughness"], 1);
        }
        assert_eq!(
            battlefield
                .iter()
                .any(|card| card["name"] == "Llanowar Elves"),
            !unsummon,
        );
    }
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_loads_every_foundations_printing_into_deck_practice() {
    let install = std::env::var("FORGE_BOLT_TEST_INSTALL").unwrap();
    let mut editions = crate::decks::catalog_editions(Some(&install)).unwrap();
    let (_, printings) = editions.remove("fdn").expect("Foundations edition");
    // Check the pinned edition independently of how many rows our importer returns.
    let names: HashSet<_> = printings.iter().map(|(_, name)| name).collect();
    assert_eq!(printings.len(), 771);
    assert_eq!(names.len(), 517);
    let mut deck = String::from("[Main]\n");
    for (number, name) in &printings {
        writeln!(deck, "1 {name}|FDN|[{number}]").unwrap();
    }
    // The saved-deck loader looks up the exact printing, checks Forge's support
    // flag and constructs its in-game Card before the opening hand is dealt.
    let engine = practice_engine(Scenario::Deck, Some(&deck));
    let dealt = zone(&engine, "player", "hand").len();
    let library = engine.current["players"]["player"]["libraryCount"]
        .as_u64()
        .unwrap() as usize;
    assert_eq!(dealt + library, printings.len());
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_surveil_hides_the_look_and_honors_the_chosen_order() {
    let mut engine = seeded_deck(
        "[Main]\n16 Island|FDN\n10 Cephalid Inkmage|FDN\n",
        Some("[Main]\n40 Forest|FDN\n"),
        743,
    );
    let cancel = AtomicBool::new(false);
    for _ in 0..80 {
        if engine.current["librarySearch"]["operation"] == "Surveil" {
            break;
        }
        let choices = engine.current["choices"].as_array().unwrap();
        let next = [
            "Cast Cephalid Inkmage",
            "Keep hand",
            "Play Island",
            "Play Forest",
            "Pass priority",
            "Discard",
            "No attacks",
        ]
        .iter()
        .find(|label| {
            choices
                .iter()
                .any(|c| c["label"].as_str().unwrap().starts_with(**label))
        })
        .unwrap_or_else(|| panic!("Unexpected choices: {choices:?}"));
        choose(&mut engine, next);
    }
    let cards = engine.current["librarySearch"]["cards"]
        .as_array()
        .expect("Surveil prompt");
    assert_eq!(cards.len(), 3);
    let ids: Vec<String> = cards
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect();
    let observer = seat_view(&engine.current, Seat::Opponent).unwrap();
    assert!(observer.get("librarySearch").is_none());
    assert_eq!(observer["choices"], serde_json::json!([]));

    let choose_card = |engine: &mut Engine, card_id: &str| {
        let choice = engine.current["choices"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["cardId"] == card_id)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        engine.next_state(Some(&choice), &cancel).unwrap();
    };
    choose_card(&mut engine, &ids[0]); // Surveil this card into the graveyard.
    choose(&mut engine, "Keep remaining on top");
    choose_card(&mut engine, &ids[2]); // Draw the third card before the second.
    assert!(zone(&engine, "player", "graveyard")
        .iter()
        .any(|c| c["id"] == ids[0]));
    assert!(engine.current.get("librarySearch").is_none());
    let mut saw_first = false;
    for _ in 0..80 {
        let hand = zone(&engine, "player", "hand");
        if hand.iter().any(|c| c["id"] == ids[1]) {
            assert!(
                saw_first,
                "The two surveilled cards were drawn out of order"
            );
            return;
        }
        saw_first |= hand.iter().any(|c| c["id"] == ids[2]);
        let options = engine.current["choices"].as_array().unwrap();
        let next = ["Pass priority", "No attacks", "No blocks", "Discard"]
            .iter()
            .find(|label| {
                options
                    .iter()
                    .any(|c| c["label"].as_str().unwrap().starts_with(**label))
            })
            .unwrap_or_else(|| panic!("Unexpected choices: {options:?}"));
        choose(&mut engine, next);
    }
    panic!("Did not reach the second draw after surveil");
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_evolving_wilds_landfall_with_doubling_season() {
    let deck = "[Main]\n14 Forest|FDN\n4 Doubling Season|FDN\n4 Mossborn Hydra|FDN\n4 Evolving Wilds|FDN\n";
    let setup = [
        "Play Forest",
        "Pass priority",
        "No attacks",
        "Discard Forest",
        "Discard",
    ];
    for fetch in [false, true] {
        let mut game = seeded_deck(deck, None, 61);
        choose(&mut game, "Keep hand");
        play_until(&mut game, "Cast Doubling Season", &setup);
        choose(&mut game, "Cast Doubling Season");
        play_until(&mut game, "Cast Mossborn Hydra", &setup);
        choose(&mut game, "Cast Mossborn Hydra");
        play_until(
            &mut game,
            "Play Evolving Wilds",
            &["Pass priority", "No attacks", "Discard Forest", "Discard"],
        );
        let hydra = |game: &Engine| {
            let card = zone(game, "player", "battlefield")
                .iter()
                .find(|card| card["name"] == "Mossborn Hydra")
                .expect("Hydra on the battlefield");
            let counters = card["counters"]["+1/+1"].as_u64().unwrap();
            assert_eq!(card["power"], counters);
            assert_eq!(card["toughness"], counters);
            counters
        };
        assert_eq!(hydra(&game), 2);

        choose(&mut game, "Play Evolving Wilds");
        assert_eq!(game.current["stack"][0]["name"], "Mossborn Hydra");
        choose(&mut game, "{T}, Sacrifice Evolving Wilds");
        play_until(&mut game, "Choose Forest", &["Pass priority"]);
        assert_eq!(hydra(&game), 2);
        assert!(zone(&game, "player", "graveyard")
            .iter()
            .any(|c| c["name"] == "Evolving Wilds"));
        choose(
            &mut game,
            if fetch {
                "Choose Forest"
            } else {
                "Finish search"
            },
        );
        // A landfall adds the existing count. Season doubles only the counters being added.
        // Declining the fetch gives one trigger (2 → 6); finding a land gives two (2 → 6 → 18).
        for _ in 0..6 {
            if game.current["stack"].as_array().unwrap().is_empty() {
                break;
            }
            choose(&mut game, "Pass priority");
        }
        assert!(game.current["stack"].as_array().unwrap().is_empty());
        assert_eq!(hydra(&game), if fetch { 18 } else { 6 });
    }
}
