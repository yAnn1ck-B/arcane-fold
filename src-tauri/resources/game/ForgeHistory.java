// Forge's engine log can include private card names in free-form messages. Build the
// shared history from the same events, keeping public identities at the instant of play.
final class ForgeHistory {
    private final Game game;
    final List<Map<String, Object>> entries = new ArrayList<>();

    ForgeHistory(Game game) {
        this.game = game;
        game.subscribeToEvents(this);
    }

    void add(String text) {
        entries.add(Map.of("turn", game.getPhaseHandler().getTurn(), "text", text));
    }

    void pass(Player actor) {
        add(actor.getName() + " passed priority.");
    }

    private static String name(forge.game.GameEntityView entity) {
        if (entity instanceof CardView card) {
            if (card.isFaceDown()) return "a face-down card";
            if (card.getZone() == null || !card.getZone().isKnown() || card.getName().isBlank()) return "a card";
        }
        return entity == null ? "a card" : entity.getName();
    }

    @Subscribe public void formatting(GameEvent event) {
        // These built-in messages contain only turn data, player names and counts.
        if (event instanceof GameEventTurnBegan || event instanceof GameEventTurnPhase
                || event instanceof GameEventScry || event instanceof GameEventSurveil
                || event instanceof GameEventMulligan || event instanceof GameEventPlayerControl) {
            var entry = event.visit(game.getGameLog().getEventVisitor());
            if (entry != null) add(entry.message());
        }
    }

    @Subscribe public void land(GameEventLandPlayed event) {
        add(event.player().getName() + " played " + name(event.land()) + ".");
        String type = event.land().getChosenType();
        if (!event.land().isFaceDown() && event.land().getZone() == ZoneType.Battlefield
                && type != null && !type.isBlank()) {
            add(event.player().getName() + " chose " + type + " for " + name(event.land()) + ".");
        }
    }

    @Subscribe public void cast(GameEventSpellAbilityCast event) {
        var item = event.si();
        var source = event.sa().getHostCard();
        String verb = event.sa().isSpell() ? " cast " : item.isTrigger() ? " triggered an ability of " : " activated an ability of ";
        String action = item.getActivatingPlayer().getName() + verb + name(source);
        List<String> targets = new ArrayList<>();
        List<String> modes = new ArrayList<>();
        for (var entry : game.getStack()) {
            if (entry.getId() != item.getId()) continue;
            var spell = entry.getSpellAbility();
            for (var group : spell.getAllTargetChoices()) {
                for (var target : group) {
                    if (target instanceof Player p) targets.add(p.getName());
                    else if (target instanceof Card c) targets.add(name(c.getView()));
                    else if (target instanceof SpellAbility s) targets.add(name(s.getHostCard().getView()));
                }
            }
            // Printed rules distinguish a permanent's multiple activated abilities.
            if (spell.isActivatedAbility() && source.getZone() == ZoneType.Battlefield && !source.isFaceDown()) {
                String rules = spell.getOriginalMapParams().get("SpellDescription");
                if (rules != null) action += " (" + rules.replace("CARDNAME", name(source)) + ")";
            }
            // Forge chains the announced modes onto the cast spell and marks their order.
            if (spell.getApi() == forge.game.ability.ApiType.Charm && source.getZone() == ZoneType.Stack && !source.isFaceDown()) {
                for (var mode = spell.getSubAbility(); mode != null; mode = mode.getSubAbility()) {
                    String text = mode.getOriginalMapParams().get("SpellDescription");
                    if (!mode.getSVar("CharmOrder").isEmpty() && text != null) modes.add(text.replace("CARDNAME", name(source)));
                }
            }
            break;
        }
        if (!targets.isEmpty()) action += " targeting " + String.join(", ", targets);
        add(action + ".");
        for (String mode : modes) add(item.getActivatingPlayer().getName() + " chose “" + mode + "”");
    }

    @Subscribe public void resolved(GameEventSpellResolved event) {
        String source = name(event.spell().getHostCard());
        String subject = event.spell().isSpell() ? source : "The ability of " + source;
        add(subject + (event.hasFizzled() ? " failed to resolve." : " resolved."));
    }

    @Subscribe public void attackers(GameEventAttackersDeclared event) {
        List<String> attacks = new ArrayList<>();
        event.attackersMap().asMap().forEach((defender, attackers) -> {
            if (!attackers.isEmpty()) attacks.add(event.player().getName() + " attacked " + name(defender)
                    + " with " + String.join(", ", attackers.stream().map(ForgeHistory::name).sorted().toList()) + ".");
        });
        if (attacks.isEmpty()) add(event.player().getName() + " declared no attackers.");
        else attacks.stream().sorted().forEach(this::add);
    }

    @Subscribe public void blockers(GameEventBlockersDeclared event) {
        List<String> blocks = new ArrayList<>();
        for (var group : event.blockers().values()) {
            group.asMap().forEach((attacker, blockers) -> {
                // Forge uses the attacker itself as the placeholder for an unblocked attacker.
                List<String> actual = blockers.stream().filter(card -> card != attacker)
                        .map(ForgeHistory::name).sorted().toList();
                String defender = event.defendingPlayer().getName();
                blocks.add(actual.isEmpty() ? defender + " left " + name(attacker) + " unblocked."
                        : defender + " blocked " + name(attacker) + " with " + String.join(", ", actual) + ".");
            });
        }
        if (blocks.isEmpty()) add(event.defendingPlayer().getName() + " declared no blockers.");
        else blocks.stream().sorted().forEach(this::add);
    }

    @Subscribe public void zone(GameEventCardChangeZone event) {
        if (event.to() == null || event.from() == null) return;
        var from = event.from().zoneType();
        var to = event.to().zoneType();
        if (from == to || to == ZoneType.Stack) return;
        // DigEffect applies ExileFaceDown after publishing this move. A card's identity
        // on a hidden-zone-to-exile transition cannot be inferred from this event.
        String card = to.isKnown() && !(from.isHidden() && to == ZoneType.Exile) ? name(event.card()) : "a card";
        add(Character.toUpperCase(card.charAt(0)) + card.substring(1)
                + " moved from " + zoneName(event.from()) + " to " + zoneName(event.to()) + ".");
    }

    private static String zoneName(forge.game.zone.ZoneView zone) {
        String place = zone.zoneType().name().toLowerCase(java.util.Locale.ROOT);
        if (zone.zoneType() == ZoneType.Exile) return place;
        if (zone.player() == null || zone.zoneType() == ZoneType.Stack || zone.zoneType() == ZoneType.Battlefield) return "the " + place;
        return zone.player().getName() + "'s " + place;
    }

    @Subscribe public void shuffle(GameEventShuffle event) {
        add(event.player().getName() + " shuffled their library.");
    }

    @Subscribe public void discarded(GameEventAddLog event) {
        if (event.type() == forge.game.GameLogEntryType.DISCARD && event.sourceCard() != null) {
            var card = event.sourceCard();
            add(card.getOwner().getName() + " discarded " + name(card) + ".");
        }
    }

    @Subscribe public void sacrificed(GameEventCardSacrificed event) {
        add(name(event.card()) + " was sacrificed.");
    }

    @Subscribe public void cardDamage(GameEventCardDamaged event) {
        add(name(event.source()) + " dealt " + event.amount() + " damage to " + name(event.card()) + ".");
    }

    @Subscribe public void playerDamage(GameEventPlayerDamaged event) {
        add(name(event.source()) + " dealt " + event.amount() + " damage to " + event.target().getName() + ".");
    }

    @Subscribe public void life(GameEventPlayerLivesChanged event) {
        if (event.oldLives() != event.newLives()) add(event.player().getName() + " went from "
                + event.oldLives() + " to " + event.newLives() + " life.");
    }

    @Subscribe public void counters(GameEventCardCounters event) {
        if (event.card().getZone() == ZoneType.Battlefield) add(name(event.card()) + " now has "
                + event.newValue() + " " + event.type().getName() + (event.newValue() == 1 ? " counter." : " counters."));
    }

    @Subscribe public void counters(GameEventPlayerCounters event) {
        if (event.type() == null) add(event.receiver().getName() + "'s counters were reset.");
        else add(event.receiver().getName() + " now has " + event.amount() + " " + event.type().getName()
                + (event.amount() == 1 ? " counter." : " counters."));
    }

    @Subscribe public void attachment(GameEventCardAttachment event) {
        if (event.newTarget() != null) add(name(event.equipment()) + " attached to " + name(event.newTarget()) + ".");
        else if (event.oldEntity() != null) add(name(event.equipment()) + " detached from " + name(event.oldEntity()) + ".");
    }

    @Subscribe public void mana(GameEventManaPool event) {
        if (event.colors() == null || event.colors().isEmpty()) return;
        String colors = String.join(" and ", event.colors().stream().sorted().map(c -> c.getName()).toList());
        if (event.mode() == EventValueChangeType.Added) add(event.player().getName() + " added " + colors + " mana.");
        else if (event.mode() == EventValueChangeType.Removed) add(event.player().getName() + " used " + colors + " mana.");
    }

    @Subscribe public void tap(GameEventCardTapped event) {
        if (event.card().getZone() == ZoneType.Battlefield) add(name(event.card()) + (event.tapped() ? " tapped." : " untapped."));
    }
}
