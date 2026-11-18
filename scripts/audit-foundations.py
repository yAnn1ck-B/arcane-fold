"""Generate the Play rules-script inventory for the pinned Forge Desktop release.

Usage: python scripts/audit-foundations.py FORGE_INSTALL [--check | --output PATH]

One row represents one FDN name. Collector numbers identify every printing.
The keyword column includes parameterized printed keywords by family. Operations
come from SP/AB/DB records, including SVar definitions. Modes and events include
trigger, replacement and static definitions. Named token scripts are verified
separately. Engine-generated abilities (e.g. basic land mana) may have no record.
Decision review lists recognizable script patterns relevant to human input; an
empty field makes no coverage claim. Focused tests are curated test functions
that assert a particular interaction for a card. They may use another printing.
The separate all-printings construction test applies to every row.
"""

import argparse
import csv
import io
import re
import sys
from collections import defaultdict
from pathlib import Path
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "docs" / "foundations-card-audit.tsv"
EDITION_SECTIONS = {
    "cards", "full art", "borderless", "alternate art", "showcase",
    "extended art", "precon product", "promo",
}
ROLES = {"A": "ability", "T": "trigger", "R": "replacement", "S": "static"}

# These tests exercise the named card's behavior. Filter out incidental cards
# (e.g. a target that simply fills the battlefield) and construction-only tests.
WITNESSES = {
    "a_targeted_mana_creature_can_pay_for_its_spell": ("Llanowar Elves", "Bite Down", "Giant Growth"),
    "giant_growth_after_blockers_or_pass": ("Giant Growth",),
    "librarian_pays_mana_changes_type_adds_counters_and_draws": ("Mild-Mannered Librarian",),
    "librarians_once_limit_survives_untapping": ("Mild-Mannered Librarian",),
    "foundations_burglar_rat_gives_the_discard_to_the_affected_seat": ("Burglar Rat",),
    "foundations_duress_reveals_the_hand_and_only_offers_legal_discards": ("Duress",),
    "foundations_tribute_to_hunger_sacrifices_the_selected_creature": ("Tribute to Hunger",),
    "foundations_lantern_offers_both_payable_abilities": ("Soul-Guide Lantern",),
    "foundations_mixed_land_can_explicitly_add_mana": ("Crawling Barrens",),
    "foundations_courtyard_uses_the_chosen_type_and_mana_color": ("Secluded Courtyard",),
    "foundations_think_twice_requires_flashback_cost_and_exiles_after_drawing": ("Think Twice",),
    "foundations_reassembling_skeleton_returns_tapped_from_its_owners_graveyard": ("Reassembling Skeleton",),
    "bushwhack_search_can_find_a_basic_or_decline": ("Bushwhack",),
    "bushwhack_can_fight_instead_of_searching": ("Bushwhack",),
    "evolving_wilds_pays_its_sacrifice_and_finds_a_tapped_basic": ("Evolving Wilds",),
    "foundations_dwynens_elite_rechecks_for_another_elf_on_resolution": ("Dwynen's Elite", "Unsummon"),
    "foundations_surveil_hides_the_look_and_honors_the_chosen_order": ("Cephalid Inkmage",),
    "foundations_evolving_wilds_landfall_with_doubling_season": ("Mossborn Hydra", "Evolving Wilds", "Doubling Season"),
    "foundations_blight_priest_conqueror_drains_to_a_win": ("Marauding Blight-Priest", "Bloodthirsty Conqueror"),
    "foundations_unsummon_breaks_the_loop_but_the_pending_trigger_resolves": ("Unsummon",),
    "foundations_tatyova_and_temple_resolve_in_either_order": ("Temple of Mystery", "Tatyova, Benthic Druid"),
    "foundations_felidar_savior_accepts_zero_one_or_two_distinct_targets": ("Felidar Savior",),
    "foundations_indrik_targets_before_the_optional_fight": ("Affectionate Indrik",),
    "wildborn_preserver_chooses_payment_on_resolution_before_the_counter_trigger": ("Wildborn Preserver",),
    "foundations_wildwood_scourge_uses_chosen_x_and_triggers_once_for_kicked_colony": ("Wildwood Scourge", "Gnarlid Colony"),
    "double_x_is_paid_twice_and_announced_before_essence_scatter": ("Essence Scatter",),
    "undo_restores_opts_private_scry_draw_and_public_history": ("Opt",),
    "foundations_divided_targets_keep_their_announced_amounts": ("Biogenic Upgrade",),
    "foundations_copied_division_can_change_targets_but_preserves_each_amount": ("Biogenic Upgrade", "Teach by Example"),
    "foundations_bolt_bend_changes_the_opponents_target_when_possible": ("Bolt Bend", "Burst Lightning"),
    "foundations_chandra_divides_damage_before_players_respond": ("Chandra, Flameshaper",),
    "foundations_mentor_draw_requires_accepting_and_paying_one_on_resolution": ("Mentor of the Meek",),
    "foundations_perforating_artist_lets_opponent_discard_sacrifice_or_lose_life": ("Perforating Artist",),
    "foundations_optional_death_triggers_use_their_human_decider": ("Kalastria Highborn", "Solemn Simulacrum"),
    "foundations_vizier_private_top_card_and_off_color_payment": ("Vizier of the Menagerie",),
    "foundations_omniscience_casts_from_hand_without_mana": ("Omniscience",),
    "foundations_blasphemous_edict_offers_alt_cost_only_at_thirteen": ("Blasphemous Edict",),
    "foundations_muldrotha_uses_a_land_drop_from_the_graveyard": ("Muldrotha, the Gravetide",),
    "foundations_chandra_exiled_choice_expires_at_end_of_turn": ("Chandra, Flameshaper",),
    "foundations_tinybones_plays_only_the_stashed_opponents_card": ("Tinybones, Bauble Burglar",),
    "foundations_strongbox_raid_exiles_and_permits_until_next_end_step": ("Strongbox Raider",),
    "foundations_etali_casts_in_chosen_order_with_human_targets": ("Etali, Primal Storm",),
    "foundations_etali_may_decline_and_cannot_play_a_land": ("Etali, Primal Storm",),
    "foundations_etali_allows_paying_or_skipping_kicker_during_resolution": ("Etali, Primal Storm", "Burst Lightning"),
    "foundations_discard_and_sacrifice_pay_the_selected_card": ("Thrill of Possibility", "Hungry Ghoul"),
    "foundations_curator_splits_privately_and_the_opponent_chooses": ("Curator of Destinies",),
    "foundations_inspiration_returns_the_selected_spell": ("Inspiration from Beyond",),
    "foundations_banner_retains_the_selected_color": ("Heraldic Banner",),
    "foundations_spyglass_reveals_privately_and_accepts_any_printed_name": ("Sorcerous Spyglass",),
    "attacker_can_assign_damage_to_either_blocker": ("Llanowar Elves",),
    "trample_requires_lethal_before_assigning_the_rest_to_the_defender": ("Rampaging Baloths",),
    "goldvein_pick_shows_its_bearer_and_creates_a_treasure_token": ("Goldvein Pick", "Healer's Hawk"),
    "chandras_token_copy_displays_its_haste_and_sacrifice_ability": ("Chandra, Flameshaper",),
    "foundations_keyword_leyline_axe_after_both_seats_keep": ("Leyline Axe",),
    "foundations_keyword_eaten_alive_requires_and_spends_one_full_cost": ("Eaten Alive",),
    "foundations_keyword_harbinger_charges_for_instant_timing": ("Harbinger of the Tides",),
    "foundations_lathril_player_selects_ten_untapped_elves_to_pay_once": ("Lathril, Blade of the Elves",),
    "foundations_pyromancers_goggles_only_copies_shock_when_its_mana_is_spent": ("Pyromancer's Goggles",),
}


def edition_printings(path):
    by_name = defaultdict(list)
    by_number = {}
    section = None
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
        elif section in EDITION_SECTIONS and line:
            match = re.fullmatch(r"(\d+) [A-Z] (.+?) @.+", line)
            if not match:
                raise ValueError(f"Unrecognized FDN printing in [{section}]: {line}")
            number, name = int(match[1]), match[2]
            if number in by_number:
                raise ValueError(f"Duplicate FDN collector number {number}")
            by_number[number] = name
            by_name[name].append(number)
    if set(by_number) != set(range(1, 772)) or len(by_name) != 517:
        raise ValueError("Expected FDN collector numbers 1–771 and 517 distinct names")
    return by_name


def card_scripts(path, names):
    found = {}
    with ZipFile(path) as archive:
        for entry in archive.infolist():
            if not entry.filename.endswith(".txt"):
                continue
            with archive.open(entry) as source:
                first = source.readline().decode("utf-8-sig").rstrip("\r\n")
                if not first.startswith("Name:") or first[5:] not in names:
                    continue
                name = first[5:]
                if name in found:
                    raise ValueError(f"Multiple Forge scripts named {name}")
                found[name] = entry.filename, source.read().decode("utf-8")
    missing = names - found.keys()
    if missing:
        raise ValueError(f"Missing Forge card scripts: {sorted(missing)}")
    return found


def parameters(value):
    # Descriptions may contain braces, dollar amounts, commas and colons. Only
    # the first $ in a pipe-delimited field separates the key and value.
    result = {}
    for field in value.split("|"):
        key, sep, argument = field.strip().partition("$")
        if sep:
            result[key.strip()] = argument.strip()
    return result


def inspect_script(source):
    result = defaultdict(set)
    for line in source.splitlines():
        field, sep, value = line.partition(":")
        if not sep:
            continue
        if field in {"Types", "ManaCost"}:
            result[field].add(value)
        elif field == "K":
            keyword, _, arguments = value.partition(":")
            result["keywords"].add(keyword)
            if keyword == "AlternateAdditionalCost":
                result["costs"].add(arguments)
        elif field in ROLES or field == "SVar":
            if field == "SVar":
                _, _, value = value.partition(":")
            fields = parameters(value)
            op = fields.get("AB") or fields.get("SP") or fields.get("DB")
            if op:
                result["operations"].add(op)
            if field == "A":
                result["roles"].add("activated" if "AB" in fields else "spell")
            elif field in ROLES:
                result["roles"].add(ROLES[field])
            for key in ("Mode", "Event"):
                if key in fields:
                    result["modes_events"].add(fields[key])
            for key in ("AddKeyword", "AddKeywords", "Keywords"):
                if key in fields:
                    result["granted_keywords"].update(fields[key].split(" & "))
            if "TokenScript" in fields:
                result["token_scripts"].update(fields["TokenScript"].split(","))
            if fields.get("MayPlay") == "True":
                result["decisions"].add("play permission from " + fields.get("AffectedZone", "unspecified zone"))
            if fields.get("Mode") == "AlternativeCost":
                result["decisions"].add("alternative cost")
            if fields.get("MayPlayWithoutManaCost") == "True":
                result["decisions"].add("cast without paying mana cost")
            result["costs"].update(fields[key] for key in ("Cost", "UnlessCost", "RaiseCost") if key in fields)
            if "X" in fields.get("Cost", "").split() and op == "ImmediateTrigger":
                result["decisions"].add("choose X on trigger resolution")
            if "DividedAsYouChoose" in fields:
                result["decisions"].add("divide an amount among targets")
            if op == "ChangeZone" and fields.get("Hidden") == "True" and fields.get("Origin") == "Graveyard":
                result["decisions"].add("choose from graveyard during resolution")
            if fields.get("Planeswalker") == "True":
                result["decisions"].add("loyalty ability")
    # These labels identify paths worth exercising. The underlying script fields
    # stay visible so reviewers can identify additional paths in the same card.
    reviews = {
        "ChangeTargets": "redirect a spell or ability",
        "ChooseCard": "choose a card during resolution",
        "ChooseColor": "choose a color",
        "ChoosePlayer": "choose a player",
        "CopySpellAbility": "copy a spell or ability",
        "Dig": "look at or move top cards",
        "GenericChoice": "choose between effects during resolution",
        "NameCard": "name a card",
        "Play": "play a card during resolution",
        "TwoPiles": "separate and choose piles",
    }
    result["decisions"].update(reviews[op] for op in result["operations"] if op in reviews)
    if result["keywords"] & {"Enchant", "Equip"} or "Attach" in result["operations"]:
        result["decisions"].add("attachment")
    if any("X" in cost.split() for cost in result["ManaCost"]):
        result["decisions"].add("announce spell X")
    if "AlternateAdditionalCost" in result["keywords"]:
        result["decisions"].add("choose an additional cost")
    if "MayEffectFromOpeningHand" in result["keywords"]:
        result["decisions"].add("use an opening-hand action")
    if "MayFlashCost" in result["keywords"]:
        result["decisions"].add("pay for instant timing")
    for cost in result["costs"]:
        if "tapXType<" in cost:
            result["decisions"].add("choose permanents to tap as payment")
        if "Discard<" in cost:
            result["decisions"].add("discard as payment")
        if re.search(r"Sac<[^/>]+/(?!CARDNAME\b)", cost):
            result["decisions"].add("choose a permanent to sacrifice as payment")
    return result


def focused_tests(names):
    paths = [ROOT / "src-tauri/src/play.rs", *(ROOT / "src-tauri/src/play").glob("*.rs")]
    tests = set()
    for path in paths:
        tests.update(re.findall(r"\bfn (real_forge_\w+)\(", path.read_text(encoding="utf-8")))
    by_name = defaultdict(list)
    for suffix, cards in WITNESSES.items():
        function = "real_forge_" + suffix
        if function not in tests:
            raise ValueError(f"Missing test function: {function}")
        for card in cards:
            if card not in names:
                raise ValueError(f"Test witness is outside FDN: {card}")
            by_name[card].append(function)
    return by_name


def joined(values):
    return "; ".join(sorted(values))


def build_report(install):
    if not (install / "forge-gui-desktop-2.0.13-jar-with-dependencies.jar").is_file():
        raise ValueError("Expected a Forge Desktop 2.0.13 installation directory")
    resources = install / "res"
    printings = edition_printings(resources / "editions/Foundations.txt")
    scripts = card_scripts(resources / "cardsfolder/cardsfolder.zip", printings.keys())
    tests = focused_tests(printings)
    stream = io.StringIO(newline="")
    output = csv.writer(stream, delimiter="\t", lineterminator="\n")
    output.writerow([
        "name", "collector_numbers", "script", "types", "mana_cost", "explicit_roles",
        "keywords", "granted_keywords", "operations_including_svars", "modes_and_events",
        "named_token_scripts", "token_script_operations", "decision_review", "focused_regression_tests",
    ])
    reviewed = 0
    for name in sorted(printings):
        path, source = scripts[name]
        rules = inspect_script(source)
        token_ops = set()
        for token in rules["token_scripts"]:
            token_path = resources / "tokenscripts" / (token + ".txt")
            token_rules = inspect_script(token_path.read_text(encoding="utf-8-sig"))
            token_ops.update(token_rules["operations"])
        reviewed += bool(rules["decisions"])
        output.writerow([
            name, ",".join(map(str, sorted(printings[name]))), path, joined(rules["Types"]),
            joined(rules["ManaCost"]), joined(rules["roles"]), joined(rules["keywords"]),
            joined(rules["granted_keywords"]), joined(rules["operations"]),
            joined(rules["modes_events"]), joined(rules["token_scripts"]), joined(token_ops),
            joined(rules["decisions"]), joined(tests.get(name, [])),
        ])
    print(f"Mapped 771 printings to {len(scripts)} scripts. {len(tests)} names with a focused "
          f"regression witness. {reviewed} names with a decision-review label.", file=sys.stderr)
    return stream.getvalue().encode("utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("forge_install", type=Path)
    parser.add_argument("--output", type=Path, default=REPORT)
    parser.add_argument("--check", action="store_true", help="compare against the existing report without writing")
    args = parser.parse_args()
    data = build_report(args.forge_install)
    if args.check:
        # Git on Windows may check out the text report with CRLF.
        if args.output.read_bytes().replace(b"\r\n", b"\n") != data:
            sys.exit(f"Report differs: {args.output}")
    else:
        args.output.write_bytes(data)


if __name__ == "__main__":
    main()
