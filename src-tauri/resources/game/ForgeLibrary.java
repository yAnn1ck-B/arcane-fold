// Forge supplies the eligible cards, applies the selection, and shuffles as instructed by the effect.
final class ForgeLibrary {
    private final ForgeMatch practice;
    private final Map<Player, List<String>> revealed = new java.util.IdentityHashMap<>();
    private SpellAbility declined;
    private List<Card> candidates;
    private String operation = "Library search";

    ForgeLibrary(ForgeMatch practice) {
        this.practice = practice;
    }

    List<Card> candidates() {
        return candidates;
    }

    String operation() {
        return operation;
    }

    // Forge consumes (top in next-draw order, cards moved away in selection order).
    org.apache.commons.lang3.tuple.ImmutablePair<CardCollection, CardCollection> arrange(
            Player actor, CardCollection cards, boolean surveil) {
        var remaining = new CardCollection(cards);
        var top = new CardCollection();
        var away = new CardCollection();
        operation = surveil ? "Surveil" : "Scry";
        try {
            String destination = surveil ? "into your graveyard" : "on the bottom";
            while (!remaining.isEmpty()) {
                Card moved = pickFromTop(actor, remaining, "Put ", " " + destination,
                        "Keep remaining on top", "Choose cards to put " + destination + ".");
                if (moved == null) break;
                remaining.remove(moved);
                away.add(moved);
            }
            while (remaining.size() > 1) {
                Card next = pickFromTop(actor, remaining, "Draw ", " next",
                        "Keep this order", "Choose the next card in top-to-bottom order.");
                if (next == null) break;
                remaining.remove(next);
                top.add(next);
            }
            top.addAll(remaining);
            return org.apache.commons.lang3.tuple.ImmutablePair.of(top, away);
        } finally {
            candidates = null;
            operation = "Library search";
        }
    }

    private Card pickFromTop(Player actor, CardCollection remaining, String prefix, String suffix,
            String doneLabel, String prompt) {
        candidates = List.copyOf(remaining);
        var choices = new ArrayList<ForgeMatch.Choice>();
        for (Card card : candidates) {
            choices.add(practice.choice(prefix + card.getName() + suffix, "card", card, null, null));
        }
        var done = practice.choice(doneLabel, "option", null, null, null);
        choices.add(done);
        var selected = practice.ask(actor, operation + " — " + prompt, choices);
        return selected == done ? null : candidates.get(choices.indexOf(selected));
    }

    void revealTo(Player recipient, CardCollectionView cards) {
        if (!cards.isEmpty()) revealed.put(recipient, cards.stream().map(c -> c.getName()).toList());
    }

    List<String> takeReveal(Player recipient) {
        return revealed.remove(recipient);
    }

    Card choose(Player actor, SpellAbility effect, CardCollection options, String title, boolean optional) {
        declined = null;
        if (options.isEmpty()) return null;
        if (!optional && options.size() == 1) return options.getFirst();
        // A search choice must not reveal the order of the unknown library.
        candidates = options.stream().sorted(java.util.Comparator.comparing((Card c) -> c.getName())
                .thenComparing(Card::getSetCode).thenComparingInt(Card::getId)).toList();
        try {
            var choices = new ArrayList<ForgeMatch.Choice>();
            var byChoice = new java.util.IdentityHashMap<ForgeMatch.Choice, Card>();
            for (Card card : candidates) {
                var choice = practice.choice("Choose " + card.getName(), "card", card, null, null);
                choices.add(choice);
                byChoice.put(choice, card);
            }
            if (optional) choices.add(practice.choice("Finish search", "option", null, null, null));
            var choice = practice.ask(actor, effect.getHostCard().getName() + " — " + title, choices);
            Card selected = byChoice.get(choice);
            if (selected == null && !effect.hasParam("SkipCancelPrompt")) declined = effect;
            return selected;
        } finally {
            candidates = null;
        }
    }

    List<Card> chooseMany(Player actor, SpellAbility effect, CardCollection options, int min, int max, String title) {
        var remaining = new CardCollection(options);
        var selected = new ArrayList<Card>();
        while (selected.size() < max && !remaining.isEmpty()) {
            String prompt = title + " (" + (selected.size() + 1) + " / " + max + ")";
            Card card = choose(actor, effect, remaining, prompt, selected.size() >= min);
            if (card == null) break;
            remaining.remove(card);
            selected.add(card);
        }
        // Forge consumes the resulting list directly for a multi-card search.
        declined = null;
        return selected;
    }

    boolean confirmedFinish(SpellAbility effect, forge.game.player.PlayerActionConfirmMode mode) {
        if (effect != declined || declined == null || mode != forge.game.player.PlayerActionConfirmMode.ChangeZoneGeneral) return false;
        // ChangeZoneEffect asks for confirmation after the explicit Finish search choice.
        declined = null;
        return true;
    }
}
