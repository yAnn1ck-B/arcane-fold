use super::tests::{choose, play_until, practice_engine, seeded_deck, zone};
use super::{Engine, Scenario};

fn until(game: &mut Engine, label: &str) {
    play_until(game, label, &["Pass priority", "No attacks", "No blocks"]);
}

fn offers(game: &Engine, label: &str) -> bool {
    game.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["label"] == label)
}

fn cast_routes(game: &Engine, name: &str) -> Vec<String> {
    game.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["label"].as_str())
        .filter(|label| label.starts_with(&format!("Cast {name}")))
        .map(str::to_owned)
        .collect()
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_pyromancers_goggles_only_copies_shock_when_its_mana_is_spent() {
    for source in ["Mountain", "Pyromancer's Goggles"] {
        let mut game = practice_engine(Scenario::Position("target-goggles"), None);
        until(&mut game, "Cast Shock");
        let board = zone(&game, "player", "battlefield");
        let source_id = &board.iter().find(|card| card["name"] == source).unwrap()["id"];
        let choices = game.current["choices"].as_array().unwrap();
        let ability = choices
            .iter()
            .find(|c| c["kind"] == "ability" && c["cardId"] == *source_id)
            .expect("Each payable mana source has its own action on its battlefield card");
        let action = ability["id"].as_str().unwrap().to_owned();
        game.next_state(Some(&action), &std::sync::atomic::AtomicBool::new(false))
            .unwrap();
        assert_eq!(game.current["players"]["player"]["mana"], 1);
        assert!(game.current["stack"].as_array().unwrap().is_empty());
        assert!(zone(&game, "player", "battlefield")
            .iter()
            .all(|card| card["tapped"] == (card["name"] == source)));
        choose(&mut game, "Cast Shock");
        choose(&mut game, "Target Player 2");
        if source == "Pyromancer's Goggles" {
            until(&mut game, "Keep Player 2");
            choose(&mut game, "Keep Player 2");
            until(&mut game, "Cast Burst Lightning");
            assert_eq!(game.current["stack"].as_array().unwrap().len(), 2);
        }
        until(&mut game, "Play Forest");
        assert_eq!(
            game.current["players"]["opponent"]["life"],
            if source == "Mountain" { 18 } else { 16 }
        );
        assert_eq!(game.current["players"]["player"]["mana"], 0);
        assert!(zone(&game, "player", "battlefield")
            .iter()
            .all(|card| card["tapped"] == (card["name"] == source)));
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_keyword_leyline_axe_after_both_seats_keep() {
    let deck = "[main]\n8 Plains|FDN\n9 Leyline Axe|FDN\n";
    let mut game = seeded_deck(deck, Some(deck), 42);
    choose(&mut game, "Mulligan");
    // The two seats complete the London mulligan before either can use an Axe.
    while !offers(&game, "Use Leyline Axe") {
        assert!(game.current["phase"] == "Opening hand");
        if offers(&game, "Keep hand") {
            choose(&mut game, "Keep hand");
        } else {
            choose(&mut game, "Bottom Leyline Axe");
        }
    }
    assert_eq!(game.current["actor"], "player");
    assert_eq!(zone(&game, "player", "hand").len(), 6);
    assert!(zone(&game, "player", "battlefield").is_empty());
    choose(&mut game, "Use Leyline Axe");
    if game.current["actor"] == "player" {
        choose(&mut game, "Finish opening hand actions");
    }
    assert_eq!(game.current["actor"], "opponent");
    assert_eq!(game.current["phase"], "Opening hand");
    assert_eq!(game.current["players"]["player"]["handCount"], 5);
    assert_eq!(
        zone(&game, "player", "battlefield")[0]["name"],
        "Leyline Axe"
    );
    choose(&mut game, "Finish opening hand actions");
    until(&mut game, "Play Plains");
    assert!(zone(&game, "opponent", "battlefield").is_empty());
    assert_eq!(game.current["players"]["opponent"]["handCount"], 7);
    assert!(game.current["stack"].as_array().unwrap().is_empty());
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_keyword_eaten_alive_requires_and_spends_one_full_cost() {
    for (position, pay_mana) in [
        ("target-eaten-poor", false),
        ("target-eaten-rich", true),
        ("target-eaten-none", false),
    ] {
        let mut game = practice_engine(Scenario::Position(position), None);
        until(&mut game, "Play Forest");
        let routes = cast_routes(&game, "Eaten Alive");
        if position.ends_with("none") {
            assert!(routes.is_empty(), "{routes:?}");
            continue;
        }
        assert_eq!(routes.len(), if pay_mana { 2 } else { 1 }, "{routes:?}");
        assert!(!offers(&game, "Cast Eaten Alive"));
        let route = routes
            .iter()
            .find(|r| r.to_lowercase().contains("sacrifice") != pay_mana)
            .unwrap();
        choose(&mut game, route);
        choose(&mut game, "Target Runeclaw Bear");
        if !pay_mana {
            assert!(offers(&game, "Sacrifice Healer's Hawk"));
            choose(&mut game, "Sacrifice Elvish Visionary");
        }
        until(&mut game, "Play Forest");
        assert!(zone(&game, "opponent", "exile")
            .iter()
            .any(|c| c["name"] == "Runeclaw Bear"));
        assert_eq!(
            zone(&game, "player", "graveyard")
                .iter()
                .any(|c| c["name"] == "Elvish Visionary"),
            !pay_mana
        );
        assert_eq!(
            zone(&game, "player", "battlefield")
                .iter()
                .filter(|c| c["name"] == "Swamp" && c["tapped"] == true)
                .count(),
            if pay_mana { 5 } else { 1 }
        );
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_keyword_harbinger_charges_for_instant_timing() {
    for (position, flash) in [
        ("target-harbinger-poor", false),
        ("target-harbinger-rich", true),
    ] {
        let mut game = practice_engine(Scenario::Position(position), None);
        until(&mut game, "Cast Opt");
        assert_ne!(game.current["phase"], "Precombat main phase");
        assert!(!offers(&game, "Cast Harbinger of the Tides"));
        let routes = cast_routes(&game, "Harbinger of the Tides");
        if flash {
            assert_eq!(routes.len(), 1, "{routes:?}");
            assert!(routes[0].contains("with flash"));
            choose(&mut game, &routes[0]);
        } else {
            assert!(routes.is_empty());
            until(&mut game, "Play Forest");
            assert_eq!(
                cast_routes(&game, "Harbinger of the Tides"),
                vec!["Cast Harbinger of the Tides"]
            );
            choose(&mut game, "Cast Harbinger of the Tides");
        }
        until(&mut game, "Target Runeclaw Bear");
        assert!(!offers(&game, "Target Healer's Hawk"));
        choose(&mut game, "Target Runeclaw Bear");
        until(&mut game, "Use ability");
        choose(&mut game, if flash { "Use ability" } else { "Decline" });
        until(&mut game, "Play Forest");
        assert!(zone(&game, "player", "battlefield")
            .iter()
            .any(|c| c["name"] == "Harbinger of the Tides"));
        let bear_zone = if flash { "hand" } else { "battlefield" };
        assert!(zone(&game, "opponent", bear_zone)
            .iter()
            .any(|c| c["name"] == "Runeclaw Bear"));
        assert_eq!(
            zone(&game, "player", "battlefield")
                .iter()
                .filter(|c| c["name"] == "Island" && c["tapped"] == true)
                .count(),
            if flash { 4 } else { 2 }
        );
    }
}

fn counters(game: &Engine, seat: &str, name: &str) -> u64 {
    zone(game, seat, "battlefield")
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()["counters"]["+1/+1"]
        .as_u64()
        .unwrap_or(0)
}

fn divide(game: &mut Engine) {
    until(game, "Cast Biogenic Upgrade");
    choose(game, "Cast Biogenic Upgrade");
    assert!(!offers(game, "Confirm targets"));
    choose(game, "Target Llanowar Elves");
    choose(game, "Target Runeclaw Bear");
    choose(game, "Confirm targets");
    assert!(offers(game, "Assign 1") && offers(game, "Assign 2"));
    assert!(!offers(game, "Assign 0") && !offers(game, "Assign 3"));
    choose(game, "Assign 2");
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_divided_targets_keep_their_announced_amounts() {
    for bounce in [false, true] {
        let mut game = practice_engine(Scenario::Position("target-divide"), None);
        divide(&mut game);
        until(&mut game, "Cast Unsummon");
        assert_eq!(
            game.current["stack"][0]["target"],
            "Llanowar Elves (2), Runeclaw Bear (1)"
        );
        if bounce {
            choose(&mut game, "Cast Unsummon");
            choose(&mut game, "Target Llanowar Elves");
        }
        until(&mut game, "Play Forest");
        assert_eq!(game.current["stack"].as_array().unwrap().len(), 0);
        assert_eq!(counters(&game, "opponent", "Runeclaw Bear"), 2);
        if bounce {
            assert!(zone(&game, "player", "hand")
                .iter()
                .any(|c| c["name"] == "Llanowar Elves"));
        } else {
            assert_eq!(counters(&game, "player", "Llanowar Elves"), 4);
        }
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_copied_division_can_change_targets_but_preserves_each_amount() {
    let mut game = practice_engine(Scenario::Position("target-copy"), None);
    until(&mut game, "Cast Teach by Example");
    choose(&mut game, "Cast Teach by Example");
    divide(&mut game);
    until(&mut game, "Keep Llanowar Elves");
    assert_eq!(game.current["actor"], "player");
    assert!(game.current["prompt"]
        .as_str()
        .unwrap()
        .contains("2 assigned"));
    choose(&mut game, "Target Elvish Visionary");
    assert!(!offers(&game, "Target Elvish Visionary"));
    choose(&mut game, "Keep Runeclaw Bear");
    until(&mut game, "Cast Unsummon");
    assert_eq!(
        game.current["stack"][0]["target"],
        "Elvish Visionary (2), Runeclaw Bear (1)"
    );
    assert_eq!(
        game.current["stack"][1]["target"],
        "Llanowar Elves (2), Runeclaw Bear (1)"
    );
    until(&mut game, "Play Forest");
    assert_eq!(counters(&game, "player", "Llanowar Elves"), 4);
    assert_eq!(counters(&game, "player", "Elvish Visionary"), 4);
    assert_eq!(counters(&game, "opponent", "Runeclaw Bear"), 6);
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_bolt_bend_changes_the_opponents_target_when_possible() {
    for can_change in [true, false] {
        let position = if can_change {
            "target-bend"
        } else {
            "target-no-change"
        };
        let mut game = practice_engine(Scenario::Position(position), None);
        let spell = if can_change {
            "Burst Lightning"
        } else {
            "Giant Growth"
        };
        until(&mut game, &format!("Cast {spell}"));
        choose(&mut game, &format!("Cast {spell}"));
        if offers(&game, "Skip optional cost") {
            choose(&mut game, "Skip optional cost");
        }
        choose(
            &mut game,
            if can_change {
                "Target Player 2"
            } else {
                "Target Healer's Hawk"
            },
        );
        until(&mut game, "Cast Bolt Bend");
        choose(&mut game, "Cast Bolt Bend");
        choose(&mut game, &format!("Target {spell}"));
        if can_change {
            until(&mut game, "Target Player 1");
            assert_eq!(game.current["actor"], "player");
            assert!(!offers(&game, "Target Player 2"));
            choose(&mut game, "Target Player 1");
        }
        // The active player can retain priority in response. Reach the first main
        // with the stack empty even when the duel began at upkeep.
        until(&mut game, "Play Forest");
        assert!(game.current["stack"].as_array().unwrap().is_empty());
        assert_eq!(game.current["players"]["opponent"]["life"], 20);
        if can_change {
            assert_eq!(game.current["players"]["player"]["life"], 18);
        } else {
            let hawk = zone(&game, "opponent", "battlefield")
                .iter()
                .find(|c| c["name"] == "Healer's Hawk")
                .unwrap();
            assert_eq!(hawk["power"], 4);
        }
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_chandra_divides_damage_before_players_respond() {
    let mut game = practice_engine(Scenario::Position("target-chandra"), None);
    until(&mut game, "Cast Chandra");
    choose(&mut game, "Cast Chandra");
    until(&mut game, "-4:");
    choose(&mut game, "-4:");
    assert!(offers(&game, "Confirm targets")); // "Any number" includes zero.
    choose(&mut game, "Target Chandra");
    choose(&mut game, "Target Runeclaw Bear");
    choose(&mut game, "Confirm targets");
    choose(&mut game, "Assign 1");
    until(&mut game, "Cast Burst Lightning");
    assert_eq!(
        game.current["stack"][0]["target"],
        "Chandra, Flameshaper (1), Runeclaw Bear (7)"
    );
    until(&mut game, "Play Forest");
    assert!(zone(&game, "opponent", "graveyard")
        .iter()
        .any(|c| c["name"] == "Runeclaw Bear"));
    let chandra = zone(&game, "player", "battlefield")
        .iter()
        .find(|c| c["name"] == "Chandra, Flameshaper")
        .unwrap();
    assert_eq!(chandra["counters"]["Loyalty"], 1);
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_mentor_draw_requires_accepting_and_paying_one_on_resolution() {
    for (scenario, accept) in [
        ("target-mentor", true),
        ("target-mentor", false),
        ("target-mentor-spent", false),
    ] {
        let mut game = practice_engine(Scenario::Position(scenario), None);
        until(&mut game, "Cast Healer's Hawk");
        choose(&mut game, "Cast Healer's Hawk");
        until(&mut game, "Cast Burst Lightning");
        assert_eq!(game.current["stack"][0]["name"], "Healer's Hawk");
        choose(&mut game, "Pass priority");
        until(&mut game, "Cast Burst Lightning");
        assert_eq!(game.current["stack"][0]["name"], "Mentor of the Meek");
        let hand = zone(&game, "player", "hand").len();
        let tapped = |g: &Engine| {
            zone(g, "player", "battlefield")
                .iter()
                .filter(|c| c["tapped"] == true)
                .count()
        };
        let tapped_before = tapped(&game);
        choose(&mut game, "Pass priority");
        if scenario != "target-mentor-spent" {
            assert_eq!(game.current["actor"], "player");
            assert!(offers(&game, "Decline"));
            choose(&mut game, if accept { "Pay " } else { "Decline" });
        }
        until(&mut game, "Play Forest");
        assert_eq!(
            zone(&game, "player", "hand").len(),
            hand + usize::from(accept)
        );
        assert_eq!(tapped(&game), tapped_before + usize::from(accept));
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_perforating_artist_lets_opponent_discard_sacrifice_or_lose_life() {
    for outcome in ["discard", "sacrifice", "lose"] {
        let mut game = practice_engine(Scenario::Position("target-artist"), None);
        until(&mut game, "Attack Player 2 with Perforating Artist");
        choose(&mut game, "Attack Player 2 with Perforating Artist");
        choose(&mut game, "Confirm attackers");
        let sacrifice = "You lose 3 life unless you sacrifice";
        let discard = "You lose 3 life unless you discard";
        until(&mut game, discard);
        assert_eq!(game.current["actor"], "opponent");
        assert_eq!(game.current["players"]["opponent"]["life"], 17);
        choose(
            &mut game,
            if outcome == "sacrifice" {
                sacrifice
            } else {
                discard
            },
        );
        if outcome == "lose" {
            choose(&mut game, "Decline");
        } else {
            choose(&mut game, "Pay ");
            choose(
                &mut game,
                if outcome == "discard" {
                    "Discard Forest"
                } else {
                    "Sacrifice Healer's Hawk"
                },
            );
        }
        until(&mut game, "Cast Burst Lightning");
        assert_eq!(
            game.current["players"]["opponent"]["life"],
            if outcome == "lose" { 14 } else { 17 }
        );
        let grave = zone(&game, "opponent", "graveyard");
        assert_eq!(
            grave.iter().any(|c| c["name"] == "Forest"),
            outcome == "discard"
        );
        assert_eq!(
            grave.iter().any(|c| c["name"] == "Healer's Hawk"),
            outcome == "sacrifice"
        );
    }
}

#[test]
#[ignore = "requires Forge Desktop 2.0.13 and JDK 17"]
fn real_forge_foundations_optional_death_triggers_use_their_human_decider() {
    for (position, victim) in [
        ("target-solemn", "Solemn Simulacrum"),
        ("target-highborn", "Kalastria Highborn"),
    ] {
        let mut game = practice_engine(Scenario::Position(position), None);
        until(&mut game, "Cast Burst Lightning");
        choose(&mut game, "Cast Burst Lightning");
        if offers(&game, "Skip optional cost") {
            choose(&mut game, "Skip optional cost");
        }
        choose(&mut game, &format!("Target {victim}"));
        if position == "target-highborn" {
            until(&mut game, "Target Player 1");
            assert_eq!(game.current["actor"], "player");
            choose(&mut game, "Target Player 2");
            until(&mut game, "Pay ");
            choose(&mut game, "Pay ");
            until(&mut game, "Play Forest");
            assert_eq!(game.current["players"]["player"]["life"], 22);
            assert_eq!(game.current["players"]["opponent"]["life"], 18);
        } else {
            until(&mut game, "Use ability");
            assert_eq!(game.current["actor"], "player");
            let hand = zone(&game, "player", "hand").len();
            choose(&mut game, "Decline");
            until(&mut game, "Play Forest");
            assert_eq!(zone(&game, "player", "hand").len(), hand);
        }
    }
}
