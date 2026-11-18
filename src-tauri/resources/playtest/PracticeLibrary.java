// Forge supplies the eligible cards, applies the selection, and shuffles as instructed by the effect.
final class PracticeLibrary {
    private final ForgePractice practice;
    private final Map<Player, List<String>> revealed = new java.util.IdentityHashMap<>();
    private SpellAbility declined;
    private List<Card> candidates;

    PracticeLibrary(ForgePractice practice) {
        this.practice = practice;
    }

    static void setup(ForgePractice practice) {
        for (int i = 0; i < 4; i++) practice.put("Forest", practice.player, ZoneType.Battlefield);
        practice.put("Mild-Mannered Librarian", practice.player, ZoneType.Battlefield);
        practice.put("Runeclaw Bear", practice.opponent, ZoneType.Battlefield);
        for (String name : List.of("Bushwhack", "Cultivate", "Evolving Wilds")) {
            practice.put(name, practice.player, ZoneType.Hand);
        }
        for (String name : List.of("Forest", "Forest", "Mountain", "Mountain", "Island", "Giant Growth")) {
            practice.put(name, practice.player, ZoneType.Library);
        }
    }

    List<Card> candidates() {
        return candidates;
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
            var choices = new ArrayList<ForgePractice.Choice>();
            var byChoice = new java.util.IdentityHashMap<ForgePractice.Choice, Card>();
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
