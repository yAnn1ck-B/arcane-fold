// Start from a real first play and exercise each offered activation in its own game.
final class FoundationsActivations extends FoundationsFirstPlay {
    private record Route(String label, String cost, boolean mana, boolean offered) {}
    private List<Route> routes;
    private Card permanent;
    private Route wanted;
    private boolean picked, resolved, fizzled;
    private Integer stackAbility;
    private int startingSourceMana, producedMana;
    private String condition = "";
    private boolean needsAttacker;
    private final List<String> decisions = new ArrayList<>();

    FoundationsActivations(Path scratch) {
        super(scratch, Position.WIDER_BOARD);
    }

    static List<List<String>> inspect(Path scratch, String name) {
        var catalog = StaticData.instance();
        catalog.attemptToLoadCard(name, "FDN");
        PaperCard paper = catalog.getCommonCards().getCard(name, "FDN");
        if (paper == null || !paper.getEdition().equals("FDN")) throw new IllegalStateException("Missing FDN printing");
        if (!paper.getRules().getType().isPermanent()) return List.of(List.of("", "", "not a permanent", ""));
        var initial = new FoundationsActivations(scratch);
        String setup = initial.prepare(name);
        if (setup != null) return List.of(List.of("", "", setup, ""));
        initial.exercise(null);
        if (initial.routes == null) return List.of(List.of("", "", "no activation window", initial.condition));
        if (initial.routes.isEmpty()) return List.of(List.of("", "", "no battlefield ability", ""));
        List<List<String>> rows = new ArrayList<>();
        for (Route route : initial.routes) {
            String status = "unavailable in position";
            String detail = initial.condition;
            if (route.offered()) {
                try {
                    var attempt = new FoundationsActivations(scratch);
                    String replay = attempt.prepare(name);
                    if (replay != null) throw new IllegalStateException("Setup changed: " + replay);
                    status = attempt.exercise(route);
                    var details = new ArrayList<String>();
                    if (!attempt.condition.isEmpty()) details.add(attempt.condition);
                    details.addAll(attempt.decisions);
                    if (attempt.producedMana > 0) details.add("Produced " + attempt.producedMana + " mana from the source");
                    detail = String.join(" / ", details);
                } catch (RuntimeException | LinkageError failure) {
                    status = "exception";
                    detail = failure.toString();
                    System.err.println(name + " — " + route.label());
                    failure.printStackTrace(System.err);
                }
            }
            rows.add(List.of(route.label(), route.cost(), status, detail));
        }
        return rows;
    }

    private String prepare(String name) {
        forge.util.MyRandom.setRandom(new java.util.Random(42));
        String setup = probe(name);
        if (!setup.equals("spell resolved") && !setup.equals("land played")) return "setup: " + setup;
        permanent = player.getCardsIn(ZoneType.Battlefield).stream().filter(c -> c.getId() == subject.getId()).findFirst().orElse(null);
        if (permanent == null) return "left battlefield during setup";
        for (Card c : player.getCardsIn(ZoneType.Battlefield)) {
            c.setTapped(false);
            c.setSickness(false);
        }
        if (permanent.isPlaneswalker()) permanent.setCounters(forge.game.card.CounterEnumType.LOYALTY, 15);
        switch (name) {
            case "Abyssal Harvester" -> {
                game.getAction().moveToGraveyard(addFixtureCard("Walking Corpse", player, ZoneType.Battlefield), null);
                condition = "A creature entered the graveyard this turn";
            }
            case "Ayli, Eternal Pilgrim" -> {
                player.setLife(player.getStartingLife() + 10, null);
                condition = "Player is 10 life above starting life";
            }
            case "Demolition Field" -> {
                addFixtureCard("Evolving Wilds", opponent, ZoneType.Battlefield);
                condition = "Opponent controls a nonbasic land";
            }
            case "Drake Hatcher" -> {
                permanent.setCounters(forge.game.card.CounterEnumType.INCUBATION, 3);
                condition = "Source has three incubation counters";
            }
            case "Dropkick Bomber" -> {
                addFixtureCard("Goblin Piker", player, ZoneType.Battlefield);
                condition = "Player controls another Goblin";
            }
            case "Ingenious Leonin" -> {
                needsAttacker = true;
                condition = "Active player's Grizzly Bears is attacking";
            }
            case "Lathril, Blade of the Elves" -> {
                for (int i = 0; i < 11; i++) addFixtureCard("Elvish Warrior", player, ZoneType.Battlefield);
                condition = "Player controls eleven other untapped Elves";
            }
            case "Ramos, Dragon Engine" -> {
                permanent.setCounters(forge.game.card.CounterEnumType.P1P1, 5);
                condition = "Source has five +1/+1 counters";
            }
            case "Reassembling Skeleton", "Suspicious Shambler" -> {
                permanent = game.getAction().moveToGraveyard(permanent, null);
                condition = "Source is in its owner's graveyard";
            }
            case "Zul Ashur, Lich Lord" -> {
                addFixtureCard("Walking Corpse", player, ZoneType.Graveyard);
                condition = "Player has a Zombie creature in the graveyard";
            }
        }
        // Mana abilities are offered at existing priority stops.
        addFixtureCard("Giant Growth", player, ZoneType.Hand);
        return null;
    }

    private String exercise(Route route) {
        wanted = route;
        int turn = phases.getTurn();
        for (int step = 0; step < 140 && !game.isGameOver() && phases.getTurn() <= turn + 2; step++) {
            phases.mainLoopStep();
            if (routes != null && (wanted == null || !picked)) return "not offered on replay";
            if (resolved) return "resolved";
            if (fizzled) return "fizzled";
            if (producedMana > 0) return "produced mana";
        }
        return stackAbility != null ? "activated without observed resolution" :
                picked ? "selected without observed activation" : "no activation window";
    }

    @Override Choice ask(Player actor, String prompt, List<Choice> choices) {
        if (permanent == null) return super.ask(actor, prompt, choices);
        if (needsAttacker && actor == player && prompt.equals("Declare attackers") && phases.getCombat().getAttackers().isEmpty()) {
            for (Choice option : choices) {
                if (option.kind().equals("attack") && option.label().endsWith("with Grizzly Bears")) return option;
            }
        }
        if (prompt.equals("Choose a play")) {
            boolean inWindow = needsAttacker ? phases.getCombat() != null && !phases.getCombat().getAttackers().isEmpty()
                    : phases.getPhase().isMain();
            if (actor == player && phases.getPlayerTurn() == player && inWindow &&
                    game.getStack().isEmpty() && routes == null) {
                List<Choice> offered = choices.stream().filter(c -> c.kind().equals("ability")
                        && ("c" + permanent.getId()).equals(c.cardId())).toList();
                List<SpellAbility> abilities = new ArrayList<>();
                for (var ability : permanent.getNonManaAbilities()) if (ability.isActivatedAbility()) abilities.add(ability);
                abilities.addAll(permanent.getManaAbilities());
                routes = new ArrayList<>();
                for (var ability : abilities) {
                    String cardName = publicName(permanent);
                    String label = ability.getDescription().replace("CARDNAME", cardName).replace("NICKNAME", cardName);
                    String cost = ability.getPayCosts().toSimpleString().replace("CARDNAME", cardName).replace("NICKNAME", cardName);
                    boolean available = offered.stream().anyMatch(c -> c.label().equals(label));
                    routes.add(new Route(label, cost, ability.isManaAbility(), available));
                }
                if (wanted != null) {
                    for (Choice item : offered) if (item.label().equals(wanted.label())) {
                        picked = true;
                        startingSourceMana = sourceMana();
                        return item;
                    }
                }
            }
            return choices.stream().filter(c -> c.kind().equals("pass")).findFirst().orElseThrow();
        }
        Choice answer = super.ask(actor, prompt, choices);
        if (picked && !resolved && !fizzled) decisions.add(answer.label());
        return answer;
    }

    @Subscribe public void activated(GameEventSpellAbilityCast event) {
        if (picked && !event.sa().isSpell() && !event.si().isTrigger() && event.sa().getHostCard().getId() == permanent.getId()) {
            stackAbility = event.sa().getId();
        }
    }

    @Subscribe public void activationResolved(GameEventSpellResolved event) {
        if (stackAbility != null && event.spell().getId() == stackAbility) {
            fizzled = event.hasFizzled();
            resolved = !fizzled;
        }
    }

    private int sourceMana() {
        int count = 0;
        for (var mana : player.getManaPool()) {
            if (mana.getSourceCard() != null && mana.getSourceCard().getId() == permanent.getId()) count++;
        }
        return count;
    }

    @Subscribe public void manaAdded(GameEventManaPool event) {
        if (picked && wanted.mana() && event.mode() == EventValueChangeType.Added && event.player().getId() == player.getId()) {
            producedMana = Math.max(producedMana, sourceMana() - startingSourceMana);
        }
    }
}
