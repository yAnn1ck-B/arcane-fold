use super::tests::{choose, play_until, practice_engine, zone};
use super::{offered_action, seat_view, Engine, Scenario, Seat};
use std::sync::atomic::AtomicBool;

fn position(name: &'static str, play: &str) -> Engine {
    let mut game = practice_engine(Scenario::Position(name), None);
    play_until(&mut game, play, &["Pass priority"]);
    choose(&mut game, play);
    game
}

fn in_zone(game: &Engine, zone_name: &str, card: &str) -> bool {
    zone(game, "player", zone_name)
        .iter()
        .any(|c| c["name"] == card)
}

fn settle(game: &mut Engine) {
    play_until(game, "Play Forest", &["Pass priority"]);
    while !game.current["stack"].as_array().unwrap().is_empty() {
        choose(game, "Pass priority");
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_discard_and_sacrifice_pay_the_selected_card() {
    for card in ["Unsummon", "Fleeting Distraction"] {
        let mut game = position("decision-discard", "Cast Thrill of Possibility");
        assert_eq!(game.current["actor"], "player");
        assert!(seat_view(&game.current, Seat::Opponent).unwrap()["choices"]
            .as_array()
            .unwrap()
            .is_empty());
        choose(&mut game, &format!("Discard {card}"));
        settle(&mut game);
        assert!(in_zone(&game, "graveyard", card));
        assert!(in_zone(&game, "graveyard", "Thrill of Possibility"));
        assert!(in_zone(&game, "hand", "Island"));
    }
    for card in ["Llanowar Elves", "Healer's Hawk"] {
        let mut game = position("decision-sacrifice", "{1}, Sacrifice");
        assert!(!game.current["choices"]
            .to_string()
            .contains("Sacrifice Hungry Ghoul"));
        choose(&mut game, &format!("Sacrifice {card}"));
        settle(&mut game);
        assert!(in_zone(&game, "graveyard", card));
        let ghoul = zone(&game, "player", "battlefield")
            .iter()
            .find(|c| c["name"] == "Hungry Ghoul")
            .unwrap();
        assert_eq!(ghoul["counters"]["+1/+1"], 1);
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_curator_splits_privately_and_the_opponent_chooses() {
    for (pile, take_hidden) in [("First pile", true), ("Second pile", false)] {
        let mut game = position("decision-curator", "Cast Curator of Destinies");
        play_until(&mut game, "Choose Goldvein Pick", &["Pass priority"]);
        assert_eq!(game.current["actor"], "player");
        let observer = seat_view(&game.current, Seat::Opponent).unwrap();
        assert!(!observer.to_string().contains("Goldvein Pick"));
        choose(&mut game, "Choose Goldvein Pick");
        choose(&mut game, "Choose Healer's Hawk");
        choose(&mut game, "Finish selection");
        assert_eq!(game.current["actor"], "opponent");
        let options = seat_view(&game.current, Seat::Opponent).unwrap();
        assert!(options["choices"]
            .to_string()
            .contains("face down, 2 cards"));
        assert!(options["choices"].to_string().contains("Llanowar Elves"));
        assert!(!options.to_string().contains("Goldvein Pick"));
        assert!(!options.to_string().contains("Healer's Hawk"));
        choose(&mut game, pile);
        settle(&mut game);
        assert!(in_zone(
            &game,
            if take_hidden { "hand" } else { "graveyard" },
            "Goldvein Pick"
        ));
        assert!(in_zone(
            &game,
            if take_hidden { "graveyard" } else { "hand" },
            "Llanowar Elves"
        ));
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_inspiration_returns_the_selected_spell() {
    for card in ["Unsummon", "Fleeting Distraction"] {
        let mut game = position("decision-grave", "Cast Inspiration from Beyond");
        let choice = format!("Choose {card}");
        play_until(&mut game, &choice, &["Pass priority"]);
        choose(&mut game, &choice);
        settle(&mut game);
        assert!(in_zone(&game, "hand", card));
        assert!(!in_zone(&game, "graveyard", card));
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_banner_retains_the_selected_color() {
    for color in ["Blue", "Red"] {
        let mut game = position("decision-color", "Cast Heraldic Banner");
        play_until(&mut game, &color.to_lowercase(), &["Pass priority"]);
        choose(&mut game, color);
        settle(&mut game);
        let banner = zone(&game, "player", "battlefield")
            .iter()
            .find(|c| c["name"] == "Heraldic Banner")
            .unwrap();
        assert_eq!(banner["chosenColors"][0], color.to_lowercase());
        let battlefield = zone(&game, "player", "battlefield");
        let turtle = battlefield
            .iter()
            .find(|c| c["name"] == "Aegis Turtle")
            .unwrap();
        let goblin = battlefield
            .iter()
            .find(|c| c["name"] == "Fanatical Firebrand")
            .unwrap();
        assert_eq!(turtle["power"], i32::from(color == "Blue"));
        assert_eq!(goblin["power"], 1 + i32::from(color == "Red"));
    }
}

fn enter_name(game: &mut Engine, name: &str) {
    let input = game.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "name")
        .unwrap();
    let command = format!("{}|{name}", input["id"].as_str().unwrap());
    assert!(offered_action(&game.current, &command));
    game.next_state(Some(&command), &AtomicBool::new(false))
        .unwrap();
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_spyglass_reveals_privately_and_accepts_any_printed_name() {
    for name in [
        "Reassembling Skeleton",
        "Black Lotus",
        "Insectile Aberration",
    ] {
        let mut game = position("decision-name", "Cast Sorcerous Spyglass");
        play_until(&mut game, "Enter a card name", &["Pass priority"]);
        let viewer = seat_view(&game.current, Seat::Player).unwrap();
        assert!(viewer["revealedToYou"]
            .to_string()
            .contains("Soul-Guide Lantern"));
        assert!(seat_view(&game.current, Seat::Opponent)
            .unwrap()
            .get("revealedToYou")
            .is_none());
        enter_name(&mut game, "This is no printed card");
        assert!(game.current["prompt"]
            .as_str()
            .unwrap()
            .contains("unavailable"));
        assert!(game.current["revealedToYou"]
            .to_string()
            .contains("Soul-Guide Lantern"));
        enter_name(&mut game, name);
        settle(&mut game);
        let glass = zone(&game, "player", "battlefield")
            .iter()
            .find(|c| c["name"] == "Sorcerous Spyglass")
            .unwrap();
        assert_eq!(glass["namedCards"][0], name);
        play_until(&mut game, "Cast Opt", &["Pass priority"]);
        let skeleton = zone(&game, "opponent", "graveyard")
            .iter()
            .find(|c| c["name"] == "Reassembling Skeleton")
            .unwrap();
        let offered = game.current["choices"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["cardId"] == skeleton["id"]);
        assert_eq!(offered, name != "Reassembling Skeleton");
    }
}
