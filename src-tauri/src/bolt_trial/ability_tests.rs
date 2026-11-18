use super::tests::{choose, practice_engine, zone};
use super::{Engine, Scenario};
use serde_json::Value;

fn activations<'a>(game: &'a Engine, card: &str) -> Vec<&'a Value> {
    let source = zone(game, "player", "battlefield")
        .iter()
        .find(|item| item["name"] == card)
        .unwrap();
    game.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|choice| choice["kind"] == "ability" && choice["cardId"] == source["id"])
        .collect()
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_lantern_offers_both_payable_abilities() {
    for draw in [false, true] {
        let mut game = practice_engine(
            Scenario::Deck,
            Some("[Main]\n5 Forest\n5 Soul-Guide Lantern|FDN|[680]\n"),
        );
        choose(&mut game, "Keep hand");
        choose(&mut game, "Play Forest");
        choose(&mut game, "Cast Soul-Guide Lantern");
        // One land pays for the Lantern. Its second activation costs another mana.
        assert_eq!(activations(&game, "Soul-Guide Lantern").len(), 1);
        for _ in 0..25 {
            if game.current["turn"] == 3 && game.current["phase"] == "Precombat main phase" {
                break;
            }
            choose(&mut game, "Pass priority");
        }
        let options = activations(&game, "Soul-Guide Lantern");
        assert_eq!(options.len(), 2);
        assert_ne!(options[0]["id"], options[1]["id"]);
        let action = options
            .iter()
            .map(|choice| choice["label"].as_str().unwrap())
            .find(|label| {
                label.contains(if draw {
                    "Draw a card"
                } else {
                    "Exile each opponent"
                })
            })
            .unwrap()
            .to_owned();
        assert!(action.contains("Sacrifice Soul-Guide Lantern"));
        let hand = zone(&game, "player", "hand").len();
        choose(&mut game, &action);
        assert_eq!(
            zone(&game, "player", "hand").len(),
            hand + usize::from(draw)
        );
        assert!(zone(&game, "player", "graveyard")
            .iter()
            .any(|card| card["name"] == "Soul-Guide Lantern"));
        let forest = &zone(&game, "player", "battlefield")[0];
        assert_eq!(forest["name"], "Forest");
        assert_eq!(forest["tapped"], draw);
    }
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_mixed_land_can_explicitly_add_mana() {
    let mut game = practice_engine(
        Scenario::Deck,
        Some("[Main]\n20 Crawling Barrens|FDN|[685]\n"),
    );
    choose(&mut game, "Keep hand");
    for turn in [1, 3, 5, 7] {
        // Mana-only availability must not stop the match before the next land drop.
        assert_eq!(game.current["turn"], turn);
        choose(&mut game, "Play Crawling Barrens");
    }
    // The autopayer reserves the source of the activation. Offer four other
    // lands so its payment is independent of whether it will tap its source.
    if activations(&game, "Crawling Barrens").len() < 2 {
        choose(&mut game, "Play Crawling Barrens");
    }
    let turn = game.current["turn"].clone();
    let options = activations(&game, "Crawling Barrens");
    assert_eq!(options.len(), 2);
    assert!(options
        .iter()
        .any(|choice| choice["label"].as_str().unwrap().contains("+1/+1 counters")));
    let mana = options
        .iter()
        .find(|choice| choice["label"].as_str().unwrap().contains("Add {C}"))
        .unwrap();
    let source = mana["cardId"].clone();
    let action = mana["label"].as_str().unwrap().to_owned();
    choose(&mut game, &action);
    assert_eq!(game.current["turn"], turn);
    assert_eq!(game.current["players"]["player"]["mana"], 1);
    assert!(zone(&game, "player", "battlefield")
        .iter()
        .any(|card| card["id"] == source && card["tapped"] == true));
    assert!(game.current["stack"].as_array().unwrap().is_empty());
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_courtyard_uses_the_chosen_type_and_mana_color() {
    let mut game = practice_engine(
        Scenario::Deck,
        Some("[Main]\n3 Secluded Courtyard|FDN|[267]\n3 Llanowar Elves|FDN|[227]\n3 Soul-Guide Lantern|FDN|[680]\n"),
    );
    choose(&mut game, "Keep hand");
    choose(&mut game, "Play Secluded Courtyard");
    let types = game.current["choices"].as_array().unwrap();
    assert!(types
        .iter()
        .any(|choice| choice["kind"] == "type" && choice["label"] == "Elf"));
    choose(&mut game, "Elf");
    assert_eq!(zone(&game, "player", "battlefield")[0]["chosenType"], "Elf");
    assert!(game.current["history"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["text"]
            .as_str()
            .unwrap()
            .contains("chose Elf for Secluded Courtyard")));
    let options = activations(&game, "Secluded Courtyard");
    assert_eq!(options.len(), 2);
    let restricted = options
        .iter()
        .find(|choice| choice["label"].as_str().unwrap().contains("any color"))
        .unwrap();
    let action = restricted["label"].as_str().unwrap().to_owned();
    choose(&mut game, &action);
    assert_eq!(game.current["choices"].as_array().unwrap().len(), 5);
    choose(&mut game, "green");
    let options = game.current["choices"].as_array().unwrap();
    assert!(!options
        .iter()
        .any(|choice| choice["label"] == "Cast Soul-Guide Lantern"));
    choose(&mut game, "Cast Llanowar Elves");
    assert!(zone(&game, "player", "battlefield")
        .iter()
        .any(|card| card["name"] == "Llanowar Elves"));
}
