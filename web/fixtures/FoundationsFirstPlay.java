// Compiled alongside the production game adapter by scripts/check-foundations-first-play.py.
// A smoke test of one first play per name. Card-specific tests assert the actual effects.
class FoundationsFirstPlay extends ForgeMatch {
    enum Position {
        MAIN("first main"),
        WIDER_BOARD("first main with five of each basic and a tapped opposing Shivan Dragon"),
        ATTACK("opponent attacks with Shivan Dragon"),
        INSTANT("respond to opponent's targeted Giant Growth"),
        CREATURE("respond to opponent's Grizzly Bears spell");

        final String description;
        Position(String description) { this.description = description; }

        static Position secondPosition(String name) {
            return switch (name) {
                case "Elspeth's Smite", "Joust Through" -> ATTACK;
                case "Essence Scatter" -> CREATURE;
                case "An Offer You Can't Refuse", "Bolt Bend", "Cancel", "Flashfreeze",
                        "Negate", "Refute" -> INSTANT;
                default -> WIDER_BOARD;
            };
        }
    }

    private static final Map<String, PaperCard> fixturePrintings = new java.util.HashMap<>();
    private final Position position;
    private Card setupCard;
    Card subject;
    private boolean selected, cast, resolved, fizzled, landPlayed, offeredPriority;
    private int answers;

    FoundationsFirstPlay(Path scratch, Position position) {
        super(scratch, true);
        this.position = position;
        game.subscribeToEvents(this);
    }

    Card addFixtureCard(String name, Player owner, ZoneType zone) {
        PaperCard printing = fixturePrintings.computeIfAbsent(name, key -> {
            var catalog = StaticData.instance();
            catalog.attemptToLoadCard(key);
            return catalog.getCommonCards().getCard(key);
        });
        var card = CardFactory.getCard(printing, owner, game);
        owner.getZone(zone).add(card);
        return card;
    }

    @Subscribe public void castObserved(GameEventSpellAbilityCast event) {
        if (subject != null && event.sa().isSpell() && event.sa().getHostCard().getId() == subject.getId()) cast = true;
    }

    @Subscribe public void resolveObserved(GameEventSpellResolved event) {
        if (subject != null && event.spell().isSpell() && event.spell().getHostCard().getId() == subject.getId()) {
            resolved = !event.hasFizzled();
            fizzled = event.hasFizzled();
        }
    }

    @Subscribe public void landObserved(GameEventLandPlayed event) {
        if (subject != null && event.land().getId() == subject.getId()) landPlayed = true;
    }

    @Override Choice ask(Player actor, String prompt, List<Choice> choices) {
        if (++answers > 150) throw new IllegalStateException("fixture decision limit");
        if (choices.stream().anyMatch(c -> c.kind().equals("name"))) {
            return new Choice("Forest", "name", null, null, null);
        }
        if (position == Position.ATTACK && actor == opponent && prompt.equals("Declare attackers")) {
            if (phases.getCombat().getAttackers().isEmpty()) {
                return choices.stream().filter(c -> c.kind().equals("attack") && ("c" + setupCard.getId()).equals(c.cardId()))
                        .findFirst().orElseThrow();
            }
            return choices.stream().filter(c -> c.label().equals("Confirm attackers")).findFirst().orElseThrow();
        }
        if (prompt.equals("Choose a play")) {
            if (actor == opponent && responsePosition() && phases.is(PhaseType.MAIN1, opponent) && game.getStack().isEmpty()) {
                for (Choice option : choices) {
                    if (("c" + setupCard.getId()).equals(option.cardId()) && option.kind().equals("card")) return option;
                }
            }
            if (actor == player && subjectWindow() && !selected) {
                offeredPriority = true;
                for (Choice option : choices) {
                    if (("c" + subject.getId()).equals(option.cardId()) && option.kind().equals("card")) {
                        selected = true;
                        return option;
                    }
                }
            }
            return choices.stream().filter(c -> c.kind().equals("pass")).findFirst().orElseThrow();
        }
        // Exercise targeting even when the controller also offers an immediate confirmation.
        if (prompt.startsWith("Choose a target for ")) {
            // These costs can legally sacrifice their own target. Aim at a surviving opposing creature.
            if (prompt.equals("Choose a target for Eaten Alive") || prompt.equals("Choose a target for Ayli, Eternal Pilgrim")) {
                for (Card creature : opponent.getCreaturesInPlay()) {
                    for (Choice option : choices) if (("c" + creature.getId()).equals(option.cardId())) return option;
                }
            }
            for (Choice option : choices) if (option.kind().equals("target")) return option;
        }
        for (String preferred : List.of("No attacks", "Confirm attackers", "No blocks", "Confirm blockers",
                "X = 1", "Skip optional cost", "Confirm targets", "Confirm modes",
                "Finish selection", "Finish search", "Decline")) {
            for (Choice option : choices) if (option.label().equals(preferred)) return option;
        }
        // Forge withholds confirmation until all mandatory attackers or blockers are declared.
        for (Choice option : choices) {
            if (option.label().startsWith("Attack ") || option.label().startsWith("Block ")) return option;
        }
        return choices.get(0);
    }

    private boolean responsePosition() {
        return position == Position.INSTANT || position == Position.CREATURE;
    }

    private boolean subjectWindow() {
        if (responsePosition()) {
            return !game.getStack().isEmpty() && game.getStack().peekAbility().getHostCard().getId() == setupCard.getId();
        }
        if (position == Position.ATTACK) {
            return phases.getCombat() != null && phases.getCombat().isAttacking(setupCard);
        }
        return phases.is(PhaseType.MAIN1, player);
    }

    String probe(String name) {
        var catalog = StaticData.instance();
        catalog.attemptToLoadCard(name, "FDN");
        PaperCard printing = catalog.getCommonCards().getCard(name, "FDN");
        if (printing == null || !printing.getEdition().equals("FDN")) throw new IllegalStateException("missing FDN printing");
        subject = CardFactory.getCard(printing, player, game);
        player.getZone(ZoneType.Hand).add(subject);
        // The spare land ensures Play has a decision even when the subject cannot be cast.
        addFixtureCard("Forest", player, ZoneType.Hand);
        for (Player seat : game.getPlayers()) {
            addFixtureCard("Grizzly Bears", seat, ZoneType.Battlefield);
            addFixtureCard("Ornithopter", seat, ZoneType.Battlefield);
            addFixtureCard("Glorious Anthem", seat, ZoneType.Battlefield);
            addFixtureCard("Llanowar Elves", seat, ZoneType.Graveyard);
            addFixtureCard("Giant Growth", seat, ZoneType.Hand);
            for (int i = 0; i < 15; i++) {
                addFixtureCard(i % 2 == 0 ? "Forest" : "Grizzly Bears", seat, ZoneType.Library);
            }
        }
        for (String basic : List.of("Plains", "Island", "Swamp", "Mountain", "Forest")) {
            int copies = position == Position.WIDER_BOARD ? 5 : 3;
            for (int i = 0; i < copies; i++) addFixtureCard(basic, player, ZoneType.Battlefield);
        }
        if (position == Position.WIDER_BOARD) {
            addFixtureCard("Shivan Dragon", opponent, ZoneType.Battlefield).setTapped(true);
            addFixtureCard("Doom Blade", player, ZoneType.Graveyard);
        } else if (position == Position.ATTACK) {
            setupCard = addFixtureCard("Shivan Dragon", opponent, ZoneType.Battlefield);
            setupCard.setSickness(false);
        } else if (responsePosition()) {
            String spell = position == Position.CREATURE ? "Grizzly Bears" : "Giant Growth";
            setupCard = addFixtureCard(spell, opponent, ZoneType.Hand);
            for (int i = 0; i < 2; i++) addFixtureCard("Forest", opponent, ZoneType.Battlefield);
        }
        Player active = responsePosition() || position == Position.ATTACK ? opponent : player;
        game.setStartingPlayer(active);
        game.setAge(GameStage.Play);
        phases.setupFirstTurn(active, null);
        // Run through the resulting triggers as well as the original spell.
        // Forge can queue an enters trigger immediately after the spell-resolved event.
        boolean firstPlaySeen = false;
        for (int step = 0; step < 120 && !game.isGameOver(); step++) {
            phases.mainLoopStep();
            if (resolved || landPlayed) {
                if ((firstPlaySeen || game.isGameOver()) && game.getStack().isEmpty() &&
                        new ForgeManual(game, player).pendingEffects().isEmpty()) {
                    return landPlayed ? "land played" : "spell resolved";
                }
                firstPlaySeen = true;
                continue;
            }
            if (fizzled) return "spell fizzled";
            if (offeredPriority && !selected) return "no play offered in fixture";
            if (phases.getTurn() > 1) break;
        }
        return cast ? "cast without observed resolution" : selected ? "selected without observed cast" : "no fixture priority observed";
    }

    public static void main(String[] args) throws Exception {
        Path scratch = Path.of(args[1]);
        ForgeGame.loadForge(Path.of(args[0]), scratch, true);
        var watchdog = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
        boolean activations = args.length > 4 && args[4].equals("activations");
        // An activation row can run several independent games for a single multi-ability card.
        int timeoutSeconds = activations ? 90 : 30;
        try (var results = Files.newBufferedWriter(Path.of(args[3]), StandardCharsets.UTF_8)) {
            for (String name : Files.readAllLines(Path.of(args[2]), StandardCharsets.UTF_8)) {
                var timeout = watchdog.schedule(() -> {
                    try {
                        results.write(name + "\tfixture timeout\t" + timeoutSeconds + " seconds without finishing this play\n");
                        results.flush();
                    } catch (IOException ex) {
                        ex.printStackTrace(System.err);
                    }
                    Runtime.getRuntime().halt(75);
                }, timeoutSeconds, java.util.concurrent.TimeUnit.SECONDS);
                String status;
                String detail = "";
                try {
                    forge.util.MyRandom.setRandom(new java.util.Random(42));
                    if (activations) {
                        var rows = FoundationsActivations.inspect(scratch, name);
                        var json = new StringWriter();
                        new JsonObjectWriter(json, 6).value(NoOpLogger.getInstance(), rows);
                        status = "activation checks";
                        detail = json.toString();
                    } else {
                        status = new FoundationsFirstPlay(scratch, Position.MAIN).probe(name);
                        if (status.equals("no play offered in fixture")) {
                            Position next = Position.secondPosition(name);
                            detail = next.description;
                            forge.util.MyRandom.setRandom(new java.util.Random(42));
                            status = new FoundationsFirstPlay(scratch, next).probe(name);
                        }
                    }
                } catch (RuntimeException | LinkageError ex) {
                    status = "exception";
                    detail = (detail.isEmpty() ? "" : detail + " — ") + String.valueOf(ex).replaceAll("[\\t\\r\\n]+", " ");
                    System.err.println(name);
                    ex.printStackTrace(System.err);
                } finally {
                    timeout.cancel(false);
                }
                results.write(name + "\t" + status + "\t" + detail + "\n");
                results.flush();
            }
        } finally {
            watchdog.shutdownNow();
        }
        System.exit(0); // Forge starts background threads.
    }
}
