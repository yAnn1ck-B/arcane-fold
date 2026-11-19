// Compiled in the same Java 17 source unit as ForgeMatch and its imports.
final class ForgeCombat {
    record DamageRecipient(forge.game.GameEntity entity, int lethal, boolean overflow) {
        Card damageKey() { return overflow ? null : (Card) entity; }
    }

    record DamageAssignment(Card source, int total, List<DamageRecipient> recipients, Map<Card, Integer> assigned,
            ForgeMatch.Choice defer) {
        void apply(String payload) {
            String[] values = payload.split(",", -1);
            if (values.length != recipients.size()) throw new IllegalArgumentException("Invalid combat damage assignment.");
            Map<Card, Integer> result = new LinkedHashMap<>();
            boolean lethalAssigned = true;
            int remaining = total;
            for (int i = 0; i < values.length; i++) {
                var recipient = recipients.get(i);
                int amount = Integer.parseInt(values[i]);
                if (amount < 0 || amount > remaining || (recipient.overflow() && amount > 0 && !lethalAssigned)) {
                    throw new IllegalArgumentException("Invalid combat damage assignment.");
                }
                remaining -= amount;
                if (amount < recipient.lethal()) lethalAssigned = false;
                if (amount > 0) result.put(recipient.damageKey(), amount);
            }
            if (remaining != 0) throw new IllegalArgumentException("Assign all combat damage.");
            assigned.clear();
            assigned.putAll(result);
        }
    }

    static Map<Card, Integer> damage(ForgeMatch match, Player chooser, Card source, CardCollectionView recipients,
            CardCollectionView attackers, int total, forge.game.GameEntity defender) {
        boolean tramples = defender != null && source.isAttacking() && source.hasKeyword(forge.game.keyword.Keyword.TRAMPLE);
        boolean deathtouch = source.hasKeyword(forge.game.keyword.Keyword.DEATHTOUCH);
        List<DamageRecipient> slots = new ArrayList<>();
        for (Card card : recipients) slots.add(new DamageRecipient(card, Math.max(0, card.getExcessDamageValue(deathtouch)), false));
        // Forge represents damage to the attacked player, planeswalker or battle with a null key.
        if (tramples) slots.add(new DamageRecipient(defender, 0, true));
        Map<Card, Integer> assigned = new LinkedHashMap<>();
        boolean canDefer = attackers != null && source.isAttacking() && recipients.stream().anyMatch(blocker ->
                match.phases.getCombat().getAttackersBlockedBy(blocker).stream().anyMatch(other -> other != source && attackers.contains(other)));
        int left = total;
        if (recipients.size() == 1 && !canDefer) {
            Card only = recipients.getFirst();
            int forced = tramples ? Math.min(left, slots.get(0).lethal()) : left;
            if (forced > 0) assigned.put(only, forced);
            left -= forced;
        }
        while (left > 0) {
            List<ForgeMatch.Choice> options = new ArrayList<>();
            boolean blockersHaveLethal = true;
            for (var slot : slots) {
                if (slot.overflow() && !blockersHaveLethal) break;
                Card card = slot.damageKey();
                int needed = Math.max(0, slot.lethal() - assigned.getOrDefault(card, 0));
                if (needed > 0) blockersHaveLethal = false;
                String name = slot.entity() instanceof Card c ? ForgeMatch.publicName(c) : slot.entity().getName();
                damageOptions(match, options, assigned, card, name, left, needed);
            }
            // Keep the indexed choices so that saved incremental moves can be replayed.
            var defer = match.choice("Assign another attacker's damage first", "option", null, null, null);
            boolean offersDefer = canDefer && left == total;
            if (offersDefer) options.add(defer);
            var damage = new DamageAssignment(source, total, slots, assigned, offersDefer ? defer : null);
            var selected = match.ask(chooser, "Assign combat damage from " + ForgeMatch.publicName(source)
                    + " (" + left + " remaining)", options, damage);
            if (selected == defer) return null;
            selected.run();
            left = total - assigned.values().stream().mapToInt(Integer::intValue).sum();
        }
        return assigned;
    }

    private static void damageOptions(ForgeMatch match, List<ForgeMatch.Choice> choices, Map<Card, Integer> assigned,
            Card card, String name, int left, int lethal) {
        var amounts = new java.util.LinkedHashSet<Integer>();
        amounts.add(1);
        if (lethal > 1 && lethal < left) amounts.add(lethal);
        if (left > 8) amounts.add(left / 2);
        amounts.add(left);
        for (int amount : amounts) choices.add(match.choice("Assign " + amount + " to " + name,
                "option", card, null, () -> assigned.merge(card, amount, Integer::sum)));
    }

    static void attackers(ForgeMatch practice, Player player, Combat combat) {
        if ((!practice.human(player) || (practice.skipsOptionalAttacks(player) && combat.getAttackers().isEmpty()))
                && CombatUtil.validateAttackers(combat)) return;
        while (true) {
            List<ForgeMatch.Choice> choices = new ArrayList<>();
            for (Card card : player.getCreaturesInPlay()) {
                if (combat.isAttacking(card)) {
                    choices.add(practice.choice("Hold back " + ForgeMatch.publicName(card), "attack", card, null,
                            () -> combat.removeFromCombat(card)));
                    continue;
                }
                for (var defender : combat.getDefenders()) {
                    if (CombatUtil.canAttack(card, defender)) {
                        choices.add(practice.choice("Attack " + defender.getName() + " with " + ForgeMatch.publicName(card),
                                "attack", card, null, () -> combat.addAttacker(card, defender)));
                    }
                }
            }
            ForgeMatch.Choice confirm = null;
            if (CombatUtil.validateAttackers(combat)) {
                if (choices.isEmpty()) return;
                String label = combat.getAttackers().isEmpty() ? "No attacks" : "Confirm attackers";
                confirm = practice.choice(label, "option", null, null, () -> {});
                choices.add(confirm);
            } else if (combat.getAttackers().isEmpty() && player.getCreaturesInPlay().size() == 1 && choices.size() == 1) {
                // Forge requires an attack. This is the only creature and the only legal defender.
                choices.get(0).run();
                if (CombatUtil.validateAttackers(combat)) return;
                continue;
            }
            var selected = practice.ask(player, "Declare attackers", choices);
            if (selected == confirm) return;
            selected.run();
        }
    }

    static void blockers(ForgeMatch practice, Player defender, Combat combat) {
        if (!practice.human(defender) && CombatUtil.validateBlocks(combat, defender) == null) return;
        while (true) {
            List<ForgeMatch.Choice> choices = new ArrayList<>();
            var attackers = combat.getAttackers().stream().filter(attacker -> {
                if (combat.getDefenderPlayerByAttacker(attacker) != defender) return false;
                int minimum = CombatUtil.getMinNumBlockersForAttacker(attacker, defender);
                // An individually eligible creature cannot start a menace block with no possible partner.
                return minimum <= 1 || !combat.getBlockers(attacker).isEmpty()
                        || defender.getCreaturesInPlay().stream().filter(b -> CombatUtil.canBlock(attacker, b)).limit(minimum).count() >= minimum;
            }).toList();
            List<ForgeMatch.Choice> reassignments = new ArrayList<>();
            for (Card blocker : defender.getCreaturesInPlay()) {
                var blocked = combat.getAttackersBlockedBy(blocker);
                Card previous = blocked.size() == 1 ? blocked.getFirst() : null;
                Combat withoutBlock = null;
                for (Card attacker : attackers) {
                    if (combat.isBlocking(blocker, attacker)) {
                        choices.add(practice.blockChoice("Remove block on " + ForgeMatch.publicName(attacker) + " by " + ForgeMatch.publicName(blocker),
                                blocker, attacker, true, () -> combat.removeBlockAssignment(attacker, blocker)));
                    } else if (CombatUtil.canBlock(attacker, blocker, combat)) {
                        choices.add(practice.blockChoice("Block " + ForgeMatch.publicName(attacker) + " with " + ForgeMatch.publicName(blocker),
                                blocker, attacker, false, () -> combat.addBlocker(attacker, blocker)));
                    } else if (previous != null) {
                        if (withoutBlock == null) withoutBlock = withoutAssignment(combat, previous, blocker);
                        if (CombatUtil.canBlock(attacker, blocker, withoutBlock)) {
                            reassignments.add(practice.reassignBlockChoice("Move block to " + ForgeMatch.publicName(attacker)
                                    + " with " + ForgeMatch.publicName(blocker), blocker, attacker, () -> {
                                combat.removeBlockAssignment(previous, blocker);
                                combat.addBlocker(attacker, blocker);
                            }));
                        }
                    }
                }
            }
            ForgeMatch.Choice confirm = null;
            String problem = CombatUtil.validateBlocks(combat, defender);
            if (problem == null) {
                if (choices.isEmpty()) return;
                String label = combat.getAllBlockers().isEmpty() ? "No blocks" : "Confirm blockers";
                confirm = practice.choice(label, "option", null, null, () -> {});
                choices.add(confirm);
            }
            // Append new options so the indices in existing replay journals still match.
            choices.addAll(reassignments);
            var selected = practice.ask(defender, problem == null ? "Declare blockers" : problem, choices);
            if (selected == confirm) return;
            selected.run();
        }
    }

    private static Combat withoutAssignment(Combat combat, Card attacker, Card blocker) {
        Combat preview = new Combat(combat, new forge.game.IEntityMap() {
            public Game getGame() { return blocker.getGame(); }
            public GameObject map(GameObject entity) { return entity; }
        });
        preview.removeBlockAssignment(attacker, blocker);
        return preview;
    }
}
