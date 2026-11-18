// Compiled in the same Java 17 source unit as ForgePractice and its imports.
final class PracticeCombat {
    static void setup(ForgePractice practice) {
        practice.put("Grizzly Bears", practice.player, ZoneType.Battlefield).setSickness(false);
        practice.put("Runeclaw Bear", practice.opponent, ZoneType.Battlefield).setSickness(false);
        if (practice.mode.equals("growth")) {
            practice.put("Forest", practice.player, ZoneType.Battlefield);
            practice.put("Giant Growth", practice.player, ZoneType.Hand);
        }
    }

    static void attackers(ForgePractice practice, Player player, Combat combat) {
        if (!practice.human(player) && CombatUtil.validateAttackers(combat)) return;
        while (true) {
            List<ForgePractice.Choice> choices = new ArrayList<>();
            for (Card card : player.getCreaturesInPlay()) {
                if (combat.isAttacking(card)) {
                    choices.add(practice.choice("Hold back " + ForgePractice.publicName(card), "attack", card, null,
                            () -> combat.removeFromCombat(card)));
                    continue;
                }
                for (var defender : combat.getDefenders()) {
                    if (CombatUtil.canAttack(card, defender)) {
                        choices.add(practice.choice("Attack " + defender.getName() + " with " + ForgePractice.publicName(card),
                                "attack", card, null, () -> combat.addAttacker(card, defender)));
                    }
                }
            }
            ForgePractice.Choice confirm = null;
            if (CombatUtil.validateAttackers(combat)) {
                if (choices.isEmpty()) return;
                String label = combat.getAttackers().isEmpty() ? "No attacks" : "Confirm attackers";
                confirm = practice.choice(label, "option", null, null, () -> {});
                choices.add(confirm);
            }
            var selected = practice.ask(player, "Declare attackers", choices);
            if (selected == confirm) return;
            selected.run();
        }
    }

    static void blockers(ForgePractice practice, Player defender, Combat combat) {
        if (!practice.human(defender) && CombatUtil.validateBlocks(combat, defender) == null) return;
        while (true) {
            List<ForgePractice.Choice> choices = new ArrayList<>();
            for (Card blocker : defender.getCreaturesInPlay()) {
                for (Card attacker : combat.getAttackers()) {
                    if (combat.getDefenderPlayerByAttacker(attacker) != defender) continue;
                    if (combat.isBlocking(blocker, attacker)) {
                        choices.add(practice.choice("Remove block on " + ForgePractice.publicName(attacker) + " by " + ForgePractice.publicName(blocker),
                                "block", blocker, null, () -> combat.removeBlockAssignment(attacker, blocker)));
                    } else if (CombatUtil.canBlock(attacker, blocker, combat)) {
                        choices.add(practice.choice("Block " + ForgePractice.publicName(attacker) + " with " + ForgePractice.publicName(blocker),
                                "block", blocker, null, () -> combat.addBlocker(attacker, blocker)));
                    }
                }
            }
            ForgePractice.Choice confirm = null;
            String problem = CombatUtil.validateBlocks(combat, defender);
            if (problem == null) {
                if (choices.isEmpty()) return;
                String label = combat.getAllBlockers().isEmpty() ? "No blocks" : "Confirm blockers";
                confirm = practice.choice(label, "option", null, null, () -> {});
                choices.add(confirm);
            }
            var selected = practice.ask(defender, problem == null ? "Declare blockers" : problem, choices);
            if (selected == confirm) return;
            selected.run();
        }
    }
}
