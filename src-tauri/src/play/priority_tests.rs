use super::tests::{choose, play_until, practice_engine, zone};
use super::{Engine, Scenario};

fn position(name: &'static str) -> Engine {
    practice_engine(Scenario::Position(name), None)
}

fn offers(game: &Engine, label: &str) -> bool {
    game.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .any(|option| option["label"].as_str().unwrap().starts_with(label))
}

fn has_card(game: &Engine, seat: &str, location: &str, name: &str) -> bool {
    zone(game, seat, location)
        .iter()
        .any(|card| card["name"] == name)
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_priority_last_loyalty_can_be_spent_even_with_no_opposing_creatures() {
    for (scenario, payable) in [
        ("priority-loyalty-short", false),
        ("priority-loyalty", true),
    ] {
        let mut game = position(scenario);
        play_until(&mut game, "Play Forest", &["Pass priority"]);
        assert_eq!(offers(&game, "-4:"), payable);
        if payable {
            choose(&mut game, "-4:");
            choose(&mut game, "Target Vivien Reid");
            choose(&mut game, "Confirm targets");
            assert_eq!(game.current["actor"], "opponent");
            assert_eq!(game.current["stack"].as_array().unwrap().len(), 1);
            assert!(has_card(
                &game,
                "player",
                "graveyard",
                "Chandra, Flameshaper"
            ));
            assert!(has_card(&game, "opponent", "battlefield", "Vivien Reid"));
            choose(&mut game, "Pass priority");
            assert!(has_card(&game, "opponent", "graveyard", "Vivien Reid"));
        }
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_priority_targeted_mana_creature_can_float_mana_before_destruction() {
    for (scenario, float) in [
        ("priority-mana-target", true),
        ("priority-mana-target", false),
        ("priority-mana-target-tapped", false),
    ] {
        let mut game = position(scenario);
        choose(&mut game, "Cast Hero's Downfall");
        choose(&mut game, "Target Llanowar Elves");
        if game.current["actor"] == "player"
            && !game.current["stack"].as_array().unwrap().is_empty()
        {
            choose(&mut game, "Pass priority");
        }
        if !scenario.ends_with("tapped") {
            assert_eq!(game.current["actor"], "opponent");
            assert_eq!(
                game.current["choices"].as_array().unwrap().len(),
                3,
                "both mana sources and passing"
            );
            if float {
                // Use the threatened creature first. The opponent still has priority to tap the other land.
                for name in ["Llanowar Elves", "Island"] {
                    let source = zone(&game, "opponent", "battlefield")
                        .iter()
                        .find(|c| c["name"] == name)
                        .unwrap();
                    let action = game.current["choices"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|c| c["kind"] == "ability" && c["cardId"] == source["id"])
                        .unwrap()["label"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    choose(&mut game, &action);
                }
            } else {
                choose(&mut game, "Pass priority");
            }
        }
        if !game.current["stack"].as_array().unwrap().is_empty() {
            assert_eq!(game.current["actor"], "player");
            assert!(offers(&game, "Cast Opt"));
            choose(&mut game, "Pass priority");
        }
        assert!(game.current["stack"].as_array().unwrap().is_empty());
        assert!(has_card(&game, "opponent", "graveyard", "Llanowar Elves"));
        assert_eq!(
            game.current["players"]["opponent"]["mana"],
            if float { 2 } else { 0 }
        );
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_priority_mana_floated_before_day_of_judgment_pays_for_lilianas_draw() {
    for (scenario, float) in [("priority-wrath", true), ("priority-wrath-tapped", false)] {
        let mut game = position(scenario);
        choose(&mut game, "Cast Day of Judgment");
        if float {
            assert_eq!(game.current["actor"], "opponent");
            assert_eq!(game.current["stack"][0]["name"], "Day of Judgment");
            assert_eq!(game.current["players"]["opponent"]["handCount"], 0);
            let green = game.current["choices"]
                .as_array()
                .unwrap()
                .iter()
                .find(|option| {
                    option["kind"] == "ability" && option["label"].as_str().unwrap().contains("{G}")
                })
                .unwrap()["label"]
                .as_str()
                .unwrap()
                .to_owned();
            choose(&mut game, &green);
            assert_eq!(game.current["actor"], "opponent");
            choose(&mut game, "Pass priority");
        }
        // In the tapped position Day bypasses the opponent's unaffected Island. Both
        // seats have no response to Liliana's draw, which clears before the next decision.
        assert!(offers(&game, "Play Forest"));
        assert_eq!(game.current["stack"].as_array().unwrap().len(), 0);
        assert!(has_card(&game, "opponent", "graveyard", "Llanowar Elves"));
        assert!(has_card(&game, "opponent", "hand", "Think Twice"));
        assert_eq!(
            game.current["players"]["opponent"]["mana"],
            usize::from(float)
        );
        if float {
            choose(&mut game, "Pass priority");
            assert_eq!(game.current["actor"], "opponent");
            assert_eq!(game.current["phase"], "Precombat main phase");
            choose(&mut game, "Cast Think Twice");
            assert!(has_card(&game, "opponent", "graveyard", "Think Twice"));
            assert!(has_card(&game, "opponent", "hand", "Island"));
            assert_eq!(game.current["players"]["opponent"]["mana"], 0);
            assert!(zone(&game, "opponent", "battlefield")
                .iter()
                .any(|card| card["name"] == "Island" && card["tapped"] == true));
        }
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_priority_skips_empty_steps_and_stops_when_a_counterspell_gains_a_target() {
    let mut game = position("priority-counter");
    assert_eq!(game.current["phase"], "Precombat main phase");
    assert_eq!(game.current["actor"], "player");
    choose(&mut game, "Cast Savannah Lions");
    assert_eq!(game.current["actor"], "opponent");
    choose(&mut game, "Cast Essence Scatter");
    choose(&mut game, "Target Savannah Lions");
    assert!(game.current["stack"].as_array().unwrap().is_empty());
    assert!(has_card(&game, "opponent", "graveyard", "Essence Scatter"));
    assert!(has_card(&game, "player", "graveyard", "Savannah Lions"));
    assert!(offers(&game, "Play Forest"));
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_priority_can_respond_to_own_upkeep_trigger_and_own_spell() {
    let mut game = position("priority-upkeep");
    assert_eq!(game.current["step"], "Upkeep step");
    assert_eq!(game.current["stack"][0]["name"], "Phyrexian Arena");
    assert!(!offers(&game, "Cast Negate"));
    choose(&mut game, "Cast Burst Lightning");
    choose(&mut game, "Target Player 2");
    assert_eq!(game.current["actor"], "player");
    assert_eq!(game.current["stack"].as_array().unwrap().len(), 2);
    choose(&mut game, "Cast Negate");
    choose(&mut game, "Target Burst Lightning");
    assert_eq!(game.current["players"]["opponent"]["life"], 20);
    assert_eq!(game.current["players"]["player"]["life"], 19);
    assert!(has_card(&game, "player", "graveyard", "Burst Lightning"));
    assert!(has_card(&game, "player", "graveyard", "Negate"));
    assert!(has_card(&game, "player", "hand", "Island"));
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_priority_graveyard_ability_is_available_in_opponents_end_step() {
    let mut game = position("priority-end-step");
    for _ in 0..35 {
        if game.current["step"] == "End step" && game.current["actor"] == "opponent" {
            break;
        }
        choose(&mut game, "Pass priority");
    }
    assert_eq!(game.current["turn"], 1);
    assert_eq!(game.current["step"], "End step");
    let activation = game.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            c["kind"] == "ability"
                && c["label"]
                    .as_str()
                    .unwrap()
                    .contains("Reassembling Skeleton")
        })
        .unwrap()["label"]
        .as_str()
        .unwrap()
        .to_owned();
    choose(&mut game, &activation);
    assert_eq!(game.current["turn"], 2);
    let skeleton = zone(&game, "opponent", "battlefield")
        .iter()
        .find(|c| c["name"] == "Reassembling Skeleton")
        .unwrap();
    assert_eq!(skeleton["tapped"], false);
}
