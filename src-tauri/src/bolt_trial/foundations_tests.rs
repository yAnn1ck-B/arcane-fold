use super::tests::{choose, practice_engine, zone};
use super::{seat_view, Engine, Scenario, Seat};
use std::collections::HashSet;
use std::fmt::Write;
use std::sync::atomic::AtomicBool;

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_loads_every_foundations_printing_into_deck_practice() {
    let install = std::env::var("FORGE_BOLT_TEST_INSTALL").unwrap();
    let mut editions = crate::decks::catalog_editions(Some(&install)).unwrap();
    let (_, printings) = editions.remove("fdn").expect("Foundations edition");
    assert!(!printings.is_empty());
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
    let names: HashSet<_> = printings.iter().map(|(_, name)| name).collect();
    println!(
        "Forge loaded {} Foundations printings across {} distinct card names.",
        printings.len(),
        names.len()
    );
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_surveil_hides_the_look_and_honors_the_chosen_order() {
    let install = std::env::var("FORGE_BOLT_TEST_INSTALL").unwrap();
    let mut engine = Engine::launch_seeded(
        std::path::Path::new(&install),
        Scenario::Deck,
        Some("[Main]\n16 Island|FDN\n10 Cephalid Inkmage|FDN\n"),
        Some("[Main]\n40 Forest|FDN\n"),
        743,
    )
    .unwrap();
    let cancel = AtomicBool::new(false);
    engine.next_state(None, &cancel).unwrap();
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
