use super::tests::{choose, play_until, practice_engine, zone};
use super::{seat_view, Engine, Scenario, Seat};

fn position(name: &'static str) -> Engine {
    practice_engine(Scenario::Position(name), None)
}

fn offers(game: &Engine, prefix: &str) -> bool {
    game.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["label"].as_str().unwrap().starts_with(prefix))
}

fn count(game: &Engine, seat: &str, where_: &str, name: &str) -> usize {
    zone(game, seat, where_)
        .iter()
        .filter(|card| card["name"] == name)
        .count()
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_lathril_player_selects_ten_untapped_elves_to_pay_once() {
    let activation_label = |game: &Engine| {
        game.current["choices"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|choice| {
                let label = choice["label"].as_str()?;
                label
                    .contains("Each opponent loses 10 life")
                    .then(|| label.to_owned())
            })
    };
    let mut game = position("permission-lathril");
    play_until(&mut game, "Play Island", &["Pass priority"]);
    let ability = activation_label(&game).expect("ten other untapped Elves can pay the cost");
    choose(&mut game, &ability);
    for remaining in (1..=10).rev() {
        let options = game.current["choices"].as_array().unwrap();
        assert_eq!(options.len(), remaining + 1);
        assert!(offers(&game, "Tap Reclamation Sage"));
        assert!(!offers(&game, "Tap Lathril"));
        choose(&mut game, "Tap Llanowar Elves");
    }
    assert_eq!(game.current["stack"].as_array().unwrap().len(), 1);
    let battlefield = zone(&game, "player", "battlefield");
    assert_eq!(
        battlefield.iter().filter(|c| c["tapped"] == true).count(),
        11
    );
    assert!(battlefield
        .iter()
        .any(|c| c["name"] == "Reclamation Sage" && c["tapped"] == false));
    assert_eq!(game.current["players"]["opponent"]["life"], 20);
    play_until(&mut game, "Play Island", &["Pass priority"]);
    assert_eq!(game.current["players"]["opponent"]["life"], 10);
    assert_eq!(game.current["players"]["player"]["life"], 30);
    assert!(activation_label(&game).is_none());

    let mut short = position("permission-lathril-short");
    play_until(&mut short, "Play Island", &["Pass priority"]);
    assert!(zone(&short, "player", "battlefield")
        .iter()
        .any(|c| c["name"] == "Reclamation Sage" && c["tapped"] == true));
    assert!(
        activation_label(&short).is_none(),
        "a tapped or opposing Elf cannot pay the cost"
    );
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_vizier_private_top_card_and_off_color_payment() {
    let mut game = position("permission-vizier");
    let play = "Cast Llanowar Elves from library";
    play_until(&mut game, play, &["Pass priority"]);
    let private = seat_view(&game.current, Seat::Player).unwrap();
    let observer = seat_view(&game.current, Seat::Opponent).unwrap();
    assert_eq!(
        private["players"]["player"]["libraryTop"]["name"],
        "Llanowar Elves"
    );
    assert!(observer["players"]["player"].get("libraryTop").is_none());
    assert!(!observer.to_string().contains("Llanowar Elves"));
    assert!(!private.to_string().contains("libraryTopBySeat"));
    choose(&mut game, play);
    play_until(&mut game, "Play Island", &["Pass priority"]);
    assert_eq!(count(&game, "player", "battlefield", "Llanowar Elves"), 1);
    assert!(zone(&game, "player", "battlefield")
        .iter()
        .any(|c| c["name"] == "Swamp" && c["tapped"] == true));
    let next = seat_view(&game.current, Seat::Player).unwrap();
    assert_eq!(
        next["players"]["player"]["libraryTop"]["name"],
        "Giant Growth"
    );
    assert!(!offers(&game, "Cast Giant Growth"));
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_omniscience_casts_from_hand_without_mana() {
    let mut game = position("permission-free");
    let free = "Cast Llanowar Elves via Omniscience ({0})";
    play_until(&mut game, free, &["Pass priority"]);
    let routes = game.current["choices"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| {
            c["label"]
                .as_str()
                .unwrap()
                .starts_with("Cast Llanowar Elves")
        })
        .count();
    assert_eq!(routes, 1);
    choose(&mut game, free);
    play_until(&mut game, "Play Island", &["Pass priority"]);
    assert_eq!(count(&game, "player", "battlefield", "Llanowar Elves"), 1);
    assert_eq!(game.current["players"]["player"]["mana"], 0);
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_blasphemous_edict_offers_alt_cost_only_at_thirteen() {
    let mut game = position("permission-edict");
    play_until(&mut game, "Cast Ornithopter", &["Pass priority"]);
    assert!(!offers(&game, "Cast Blasphemous Edict"));
    choose(&mut game, "Cast Ornithopter");
    play_until(
        &mut game,
        "Cast Blasphemous Edict ({B})",
        &["Pass priority"],
    );
    choose(&mut game, "Cast Blasphemous Edict");
    play_until(&mut game, "Play Island", &["Pass priority"]);
    assert_eq!(count(&game, "opponent", "graveyard", "Llanowar Elves"), 12);
    assert_eq!(count(&game, "player", "graveyard", "Ornithopter"), 1);
    assert!(zone(&game, "player", "battlefield")
        .iter()
        .any(|c| c["name"] == "Swamp" && c["tapped"] == true));
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_muldrotha_uses_a_land_drop_from_the_graveyard() {
    let mut game = position("permission-muldrotha");
    let land = "Play Evolving Wilds from graveyard";
    play_until(&mut game, land, &["Pass priority"]);
    assert!(offers(&game, "Play Mountain from graveyard"));
    assert!(!offers(&game, "Cast Llanowar Elves"));
    choose(&mut game, land);
    assert_eq!(count(&game, "player", "battlefield", "Evolving Wilds"), 1);
    assert_eq!(count(&game, "player", "graveyard", "Mountain"), 1);
    assert!(!offers(&game, "Play Mountain") && !offers(&game, "Play Island"));
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_chandra_exiled_choice_expires_at_end_of_turn() {
    let mut game = position("permission-chandra");
    play_until(
        &mut game,
        "+2:",
        &["Cast Chandra, Flameshaper", "Pass priority"],
    );
    choose(&mut game, "+2:");
    play_until(&mut game, "Choose Plains", &["Pass priority"]);
    assert!(offers(&game, "Choose Swamp") && offers(&game, "Choose Mountain"));
    choose(&mut game, "Choose Plains");
    play_until(&mut game, "Play Plains from exile", &["Pass priority"]);
    assert!(!offers(&game, "Play Mountain from exile") && !offers(&game, "Play Swamp from exile"));
    for _ in 0..40 {
        if game.current["turn"] == 3 && offers(&game, "Play Island") {
            break;
        }
        if offers(&game, "No attacks") {
            choose(&mut game, "No attacks");
        } else {
            choose(&mut game, "Pass priority");
        }
    }
    assert_eq!(game.current["turn"], 3);
    assert!(offers(&game, "Play Island") && !offers(&game, "Play Plains from exile"));
    assert_eq!(count(&game, "player", "exile", "Plains"), 1);
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_tinybones_plays_only_the_stashed_opponents_card() {
    let mut game = position("permission-tinybones");
    play_until(&mut game, "Cast Burglar Rat", &["Pass priority"]);
    assert!(!offers(&game, "Play Forest from exile"));
    choose(&mut game, "Cast Burglar Rat");
    let play = "Play Plains from exile";
    play_until(&mut game, play, &["Pass priority", "Discard Plains"]);
    assert_eq!(count(&game, "opponent", "exile", "Plains"), 1);
    assert!(!offers(&game, "Play Forest from exile"));
    choose(&mut game, play);
    assert_eq!(count(&game, "player", "battlefield", "Plains"), 1);
    assert_eq!(count(&game, "opponent", "exile", "Plains"), 0);
    assert_eq!(count(&game, "opponent", "exile", "Forest"), 1);
}

fn attack_with_etali(name: &'static str) -> Engine {
    let mut game = position(name);
    play_until(&mut game, "Attack Player 2 with Etali", &["Pass priority"]);
    choose(&mut game, "Attack Player 2 with Etali");
    choose(&mut game, "Confirm attackers");
    play_until(&mut game, "Play Burst Lightning", &["Pass priority"]);
    game
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_etali_allows_paying_or_skipping_kicker_during_resolution() {
    for pay in [false, true] {
        let mut game = attack_with_etali("permission-etali-kicker");
        choose(&mut game, "Play Burst Lightning");
        assert_eq!(game.current["prompt"], "Optional cost for Burst Lightning");
        assert!(offers(&game, "Skip optional cost"));
        let kicker = game.current["choices"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["label"].as_str())
            .find(|label| label.to_lowercase().contains("kicker"))
            .expect("the player can choose the kicker payment")
            .to_owned();
        choose(&mut game, if pay { &kicker } else { "Skip optional cost" });
        choose(&mut game, "Target Player 2");
        play_until(&mut game, "Play Island", &["Pass priority", "No blocks"]);
        assert_eq!(
            game.current["players"]["opponent"]["life"],
            if pay { 10 } else { 12 }
        );
        assert_eq!(
            zone(&game, "player", "battlefield")
                .iter()
                .filter(|c| c["name"] == "Plains" && c["tapped"] == true)
                .count(),
            if pay { 4 } else { 0 }
        );
    }
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_strongbox_raid_exiles_and_permits_until_next_end_step() {
    for raid in [false, true] {
        let mut game = position("permission-raider");
        if raid {
            play_until(
                &mut game,
                "Attack Player 2 with Savannah Lions",
                &["Pass priority"],
            );
            choose(&mut game, "Attack Player 2 with Savannah Lions");
            choose(&mut game, "Confirm attackers");
        }
        play_until(
            &mut game,
            "Cast Strongbox Raider",
            &["Pass priority", "No blocks"],
        );
        choose(&mut game, "Cast Strongbox Raider");
        if !raid {
            play_until(&mut game, "Play Island", &["Pass priority"]);
            assert_eq!(count(&game, "player", "battlefield", "Strongbox Raider"), 1);
            assert!(zone(&game, "player", "exile").is_empty());
            continue;
        }
        // A spurious "Use ability / Decline" decision here would stop play_until.
        play_until(&mut game, "Choose Plains", &["Pass priority"]);
        assert!(offers(&game, "Choose Mountain"));
        assert_eq!(zone(&game, "player", "exile").len(), 2);
        choose(&mut game, "Choose Plains");
        let mut playable_turns = std::collections::BTreeSet::new();
        for _ in 0..120 {
            let turn = game.current["turn"].as_u64().unwrap();
            if offers(&game, "Play Plains from exile") {
                assert_eq!(game.current["actor"], "player");
                playable_turns.insert(turn);
            }
            assert!(!offers(&game, "Play Mountain from exile"));
            if turn == 5 && offers(&game, "Play Island") {
                break;
            }
            if offers(&game, "No attacks") {
                choose(&mut game, "No attacks");
            } else {
                choose(&mut game, "Pass priority");
            }
        }
        assert_eq!(game.current["turn"], 5);
        assert_eq!(playable_turns.into_iter().collect::<Vec<_>>(), [1, 3]);
    }
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_etali_casts_in_chosen_order_with_human_targets() {
    for first in ["Giant Growth", "Burst Lightning"] {
        let mut game = attack_with_etali("permission-etali");
        let second = if first == "Giant Growth" {
            "Burst Lightning"
        } else {
            "Giant Growth"
        };
        assert_eq!(game.current["actor"], "player");
        let observer = seat_view(&game.current, Seat::Opponent).unwrap();
        assert_eq!(
            observer["players"]["player"]["exile"][0]["name"],
            "Burst Lightning"
        );
        assert_eq!(
            observer["players"]["opponent"]["exile"][0]["name"],
            "Giant Growth"
        );
        assert!(observer["choices"].as_array().unwrap().is_empty());
        for spell in [first, second] {
            choose(&mut game, &format!("Play {spell}"));
            let target = if spell == "Burst Lightning" {
                "Target Player 2"
            } else {
                "Target Etali"
            };
            play_until(&mut game, target, &["Skip optional cost"]);
            choose(&mut game, target);
        }
        assert_eq!(game.current["stack"][0]["name"], second);
        assert_eq!(game.current["stack"][1]["name"], first);
        play_until(&mut game, "Play Island", &["Pass priority", "No blocks"]);
        assert_eq!(game.current["players"]["opponent"]["life"], 9);
        assert_eq!(count(&game, "player", "graveyard", "Burst Lightning"), 1);
        assert_eq!(count(&game, "opponent", "graveyard", "Giant Growth"), 1);
        assert_eq!(game.current["players"]["player"]["mana"], 0);
    }
}

#[test]
#[ignore = "requires a real Forge Desktop 2.0.13 install and JDK 17"]
fn real_forge_foundations_etali_may_decline_and_cannot_play_a_land() {
    for (position, cast_one) in [("permission-etali", true), ("permission-etali-land", false)] {
        let mut game = attack_with_etali(position);
        assert!(!offers(&game, "Play Mountain"));
        if cast_one {
            choose(&mut game, "Play Giant Growth");
            choose(&mut game, "Target Etali");
            assert!(offers(&game, "Play Burst Lightning"));
        }
        choose(&mut game, "Decline");
        play_until(&mut game, "Play Island", &["Pass priority", "No blocks"]);
        assert_eq!(
            game.current["players"]["opponent"]["life"],
            if cast_one { 11 } else { 14 }
        );
        assert_eq!(count(&game, "player", "exile", "Burst Lightning"), 1);
        assert_eq!(
            zone(&game, "opponent", "exile").len(),
            usize::from(!cast_one)
        );
        assert!(!offers(&game, "Play Burst Lightning"));
    }
}
