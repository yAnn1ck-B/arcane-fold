// Shares a source-file launch unit with ForgeBoltTrial and PracticeCombat.
final class ForgePractice {
    final String mode;
    final Player player;
    final Player opponent;
    private final Game game;
    private final PhaseHandler phases;
    private final PracticeHistory history;
    private final Path scratch;
    private final BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    private final PracticeLibrary library = new PracticeLibrary(this);
    private CardCollectionView revealedHand;
    private int decision;
    private final boolean secondDeck;
    private final boolean sharedSeats;

    ForgePractice(String mode, Path scratch) {
        this.mode = mode;
        this.scratch = scratch;
        secondDeck = mode.equals("deck") && Files.isRegularFile(scratch.resolve("opponent.dck"));
        sharedSeats = secondDeck || !mode.equals("deck");
        game = new Match(new GameRules(GameType.Constructed),
                List.of(seat(sharedSeats ? "Player 1" : "Player"), seat(sharedSeats ? "Player 2" : "Opponent")),
                "Forge practice").createGame();
        player = game.getPlayers().get(0);
        opponent = game.getPlayers().get(1);
        phases = game.getPhaseHandler();
        game.setStartingPlayer(player);
        for (Player p : game.getPlayers()) {
            p.setStartingLife(20);
            p.setLife(20, null);
            p.setMaxHandSize(7);
            p.setStartingHandSize(7);
        }
        history = new PracticeHistory(game);
    }

    private RegisteredPlayer seat(String name) {
        LobbyPlayerAi lobby = new LobbyPlayerAi(name, Set.of()) {
            @Override
            public Player createIngamePlayer(Game match, int id) {
                Player p = new Player(getName(), match, id);
                p.setFirstController(new Controller(match, p, this));
                return p;
            }
        };
        return new RegisteredPlayer(new Deck(name)).setPlayer(lobby);
    }

    Card put(String name, Player p, ZoneType zone) {
        StaticData.instance().attemptToLoadCard(name);
        Card card = CardFactory.getCard(StaticData.instance().getCommonCards().getCard(name), p, game);
        p.getZone(zone).add(card);
        return card;
    }

    boolean human(Player p) {
        return p == player || sharedSeats;
    }

    private void loadLibrary(Player owner, Path file) throws IOException {
        boolean main = false;
        var catalog = StaticData.instance();
        for (String row : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            String line = row.strip();
            if (line.startsWith("[")) {
                main = line.equalsIgnoreCase("[main]");
            } else if (main && !line.isEmpty() && !line.startsWith("#")) {
                String[] counted = line.split("\\s+", 2);
                String[] printing = counted[1].split("\\|", -1);
                String name = printing[0];
                String set = printing.length > 1 ? printing[1] : null;
                String collector = printing.length > 2 ? printing[2].replaceAll("^\\[|\\]$", "") : null;
                if (set == null) catalog.attemptToLoadCard(name);
                else catalog.attemptToLoadCard(name, set);
                var db = catalog.getCommonCards();
                PaperCard paper = collector != null ? db.getCard(name, set, collector)
                        : set != null ? db.getCard(name, set) : db.getCard(name);
                if (paper == null || paper.getRules().isUnsupported()
                        || set != null && !set.equalsIgnoreCase(paper.getEdition())
                        || collector != null && !collector.equals(paper.getCollectorNumber())) {
                    throw new IllegalArgumentException("Forge could not load the saved printing of " + counted[1]);
                }
                int copies = Integer.parseInt(counted[0]);
                for (int i = 0; i < copies; i++) {
                    owner.getZone(ZoneType.Library).add(CardFactory.getCard(paper, owner, game));
                }
            }
        }
        if (owner.getCardsIn(ZoneType.Library).size() < owner.getStartingHandSize()) {
            throw new IllegalArgumentException("Practice needs at least seven main-deck cards.");
        }
    }

    private void prepareDeck() throws IOException {
        loadLibrary(player, scratch.resolve("practice.dck"));
        if (secondDeck) loadLibrary(opponent, scratch.resolve("opponent.dck"));
        else for (int i = 0; i < 60; i++) put("Island", opponent, ZoneType.Library);
        game.setAge(GameStage.Mulligan);
        for (Player p : game.getPlayers()) {
            p.shuffle(null);
            p.drawCards(p.getStartingHandSize());
        }
        StaticData.instance().setMulliganRule(forge.MulliganDefs.MulliganRule.London);
        new MulliganService(player).perform();
    }

    void run() throws IOException {
        try {
            switch (mode) {
                case "response" -> {
                    put("Mountain", player, ZoneType.Hand);
                    put("Lightning Bolt", player, ZoneType.Hand);
                    put("Island", opponent, ZoneType.Battlefield);
                    put("Island", opponent, ZoneType.Battlefield);
                    put("Counterspell", opponent, ZoneType.Hand);
                }
                case "combat", "growth" -> PracticeCombat.setup(this);
                case "library" -> PracticeLibrary.setup(this);
                case "deck" -> prepareDeck();
                default -> throw new IllegalArgumentException("Unknown practice scenario.");
            }
            game.setAge(GameStage.Play);
            phases.setupFirstTurn(player, null);
            // These positions start at a specific decision. Saved-deck games always
            // start with the opening hand, followed by Forge's ordinary turn loop.
            if (mode.equals("growth")) phases.devAdvanceToPhase(PhaseType.COMBAT_DECLARE_ATTACKERS);
            while (!game.isGameOver()) {
                if ((mode.equals("combat") || mode.equals("growth") || mode.equals("library"))
                        && phases.is(PhaseType.MAIN2)) {
                    emit(player, mode.equals("library") ? "Exercise complete" : "Combat complete", List.of(), true);
                    return;
                }
                if (mode.equals("response") && game.getStack().isEmpty()
                        && !player.getCardsIn(ZoneType.Graveyard).isEmpty()) {
                    boolean countered = !opponent.getCardsIn(ZoneType.Graveyard).isEmpty();
                    emit(player, countered ? "Counterspell countered Lightning Bolt." : "Lightning Bolt resolved.", List.of(), true);
                    return;
                }
                phases.mainLoopStep();
            }
            emit(player, String.join(" ", game.getOutcome().getOutcomeStrings()), List.of(), true);
        } catch (EndInput closed) {
            // The table closed while Forge was waiting for a controller decision.
        }
    }

    static final class EndInput extends RuntimeException {}

    record Choice(String label, String kind, String cardId, Player seat, Runnable action) {
        void run() {
            if (action != null) action.run();
        }
    }

    Choice choice(String label, String kind, Card card, Player seat, Runnable action) {
        return new Choice(label, kind, card == null ? null : cardId(card), seat, action);
    }

    Choice ask(Player actor, String prompt, List<Choice> choices) {
        if (choices.isEmpty()) throw new IllegalStateException("Forge supplied no choices for " + prompt);
        decision++;
        try {
            emit(actor, prompt, choices, false);
            String selected = input.readLine();
            if (selected == null) throw new EndInput();
            for (int i = 0; i < choices.size(); i++) {
                if (choiceId(i).equals(selected)) {
                    Choice choice = choices.get(i);
                    if (choice.kind().equals("pass")) history.pass(actor);
                    return choice;
                }
            }
            throw new IllegalArgumentException("This choice is no longer available.");
        } catch (IOException ex) {
            throw new IllegalStateException("Could not exchange the Forge decision.", ex);
        }
    }

    private String choiceId(int index) { return "p" + decision + "_" + index; }
    private String seatId(Player p) { return p == opponent ? "opponent" : "player"; }
    private String cardId(Card c) { return "c" + c.getId(); }

    static String publicName(Card card) {
        return card.isFaceDown() ? "Face-down card" : card.getName();
    }

    private String phaseName(PhaseType phase) {
        if (phase == null) return "Opening hand";
        return switch (phase) {
            case UNTAP, UPKEEP, DRAW -> "Beginning phase";
            case MAIN1 -> "Precombat main phase";
            case MAIN2 -> "Postcombat main phase";
            case END_OF_TURN, CLEANUP -> "Ending phase";
            default -> "Combat phase";
        };
    }

    private String stepName(PhaseType phase) {
        if (phase == null || phase.isMain()) return "";
        return switch (phase) {
            case UNTAP -> "Untap step";
            case UPKEEP -> "Upkeep step";
            case DRAW -> "Draw step";
            case COMBAT_BEGIN -> "Beginning of combat step";
            case COMBAT_DECLARE_ATTACKERS -> "Declare attackers step";
            case COMBAT_DECLARE_BLOCKERS -> "Declare blockers step";
            case COMBAT_FIRST_STRIKE_DAMAGE -> "Combat damage step (first strike)";
            case COMBAT_DAMAGE -> "Combat damage step";
            case COMBAT_END -> "End of combat step";
            case END_OF_TURN -> "End step";
            case CLEANUP -> "Cleanup step";
            default -> "";
        };
    }

    private Map<String, Object> cardState(Card card) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", cardId(card));
        out.put("name", publicName(card));
        if (card.isFaceDown()) {
            out.put("faceDown", true);
        } else {
            out.put("oracleText", card.getOracleText().replace("\\n", "\n"));
            out.put("typeLine", card.getType().toString());
            if (card.isInZone(ZoneType.Battlefield) && card.hasChosenType()) out.put("chosenType", card.getChosenType());
            if (!card.getManaCost().isNoCost()) out.put("manaCost", card.getManaCost().toString());
            out.put("setCode", card.getSetCode());
            if (card.getPaperCard() != null) out.put("collectorNumber", card.getPaperCard().getCollectorNumber());
        }
        out.put("tapped", card.isTapped());
        if (card.isCreature()) {
            out.put("power", card.getNetPower());
            out.put("toughness", card.getNetToughness());
            if (card.getDamage() > 0) out.put("damage", card.getDamage());
        }
        if (!card.getCounters().isEmpty()) {
            Map<String, Integer> counters = new LinkedHashMap<>();
            card.getCounters().forEach((type, count) -> counters.put(type.getName(), count));
            out.put("counters", counters);
        }
        Combat combat = phases.getCombat();
        if (combat != null) {
            if (combat.isAttacking(card)) out.put("attacking", true);
            if (combat.getAllBlockers().contains(card)) {
                out.put("blocking", true);
                out.put("target", String.join(", ", combat.getAttackersBlockedBy(card).stream().map(ForgePractice::publicName).toList()));
            }
        }
        return out;
    }

    private Map<String, Object> board(Player p, boolean revealHand) {
        var hand = p.getCardsIn(ZoneType.Hand);
        return Map.of("life", p.getLife(), "mana", p.getManaPool().totalMana(),
                "libraryCount", p.getCardsIn(ZoneType.Library).size(), "handCount", hand.size(),
                "hand", revealHand ? hand.stream().map(this::cardState).toList() : List.of(),
                "battlefield", p.getCardsIn(ZoneType.Battlefield).stream().map(this::cardState).toList(),
                "exile", p.getCardsIn(ZoneType.Exile).stream().map(this::cardState).toList(),
                "graveyard", p.getCardsIn(ZoneType.Graveyard).stream().map(this::cardState).toList());
    }

    private static String targetName(GameObject obj) {
        if (obj instanceof SpellAbility spell) return publicName(spell.getHostCard());
        if (obj instanceof Player p) return p.getName();
        return publicName((Card)obj);
    }

    private void emit(Player actor, String prompt, List<Choice> choices, boolean finished) throws IOException {
        var stack = new ArrayList<Map<String, Object>>();
        for (var instance : game.getStack()) {
            var out = cardState(instance.getSourceCard());
            var spell = instance.getSpellAbility();
            if (!spell.isSpell()) {
                out.put("id", "s" + instance.getId());
                if (!instance.getSourceCard().isFaceDown()) out.put("description", spell.getStackDescription());
            }
            if (spell.getXManaCostPaid() != null && announcesManaX(spell)) {
                String announcement = "X = " + spell.getXManaCostPaid();
                out.put("description", out.containsKey("description") ? out.get("description") + " (" + announcement + ")" : announcement);
            }
            var targets = new ArrayList<String>();
            for (var group : instance.getSpellAbility().getAllTargetChoices()) {
                for (GameObject t : group) targets.add(targetName(t));
            }
            if (!targets.isEmpty()) out.put("target", String.join(", ", targets));
            stack.add(out);
        }
        var options = new ArrayList<Map<String, Object>>();
        for (Choice c : choices) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("id", choiceId(options.size()));
            out.put("label", c.label());
            out.put("kind", c.kind());
            if (c.cardId() != null) out.put("cardId", c.cardId());
            if (c.seat() != null) out.put("seat", seatId(c.seat()));
            options.add(out);
        }
        Map<String, Object> state = new LinkedHashMap<>(Map.of("stage", finished ? "finished" : "decision", "prompt", prompt,
                "actor", seatId(actor), "active", seatId(phases.getPlayerTurn()), "turn", phases.getTurn(),
                "phase", phaseName(phases.getPhase()), "step", stepName(phases.getPhase()),
                "players", Map.of("player", board(player, true), "opponent", board(opponent, sharedSeats)),
                "stack", stack, "choices", options));
        // Rust retains this snapshot and projects only the selected seat into the WebView.
        state.put("sharedSeats", sharedSeats);
        if (finished) history.add(prompt);
        state.put("history", history.entries);
        if (library.candidates() != null) {
            state.put("librarySearch", Map.of("title", prompt, "operation", library.operation(),
                    "cards", library.candidates().stream().map(this::cardState).toList()));
        } else if (revealedHand != null) {
            state.put("librarySearch", Map.of("title", prompt, "operation", "Revealed hand",
                    "cards", revealedHand.stream().map(this::cardState).toList()));
        }
        List<String> revealed = library.takeReveal(actor);
        if (revealed != null) state.put("revealedToYou", revealed);
        state.put("replayState", PracticeReplay.fingerprint(player, opponent));
        var json = new StringWriter();
        new JsonObjectWriter(json, 12).value(NoOpLogger.getInstance(), state);
        System.out.println("BOLT_STATE " + json);
        System.out.flush();
    }

    private List<GameObject> targets(SpellAbility ability) {
        var result = new ArrayList<GameObject>();
        var restrictions = ability.getTargetRestrictions();
        if (restrictions.getZone().contains(ZoneType.Stack)) {
            for (var entry : game.getStack()) {
                var spell = entry.getSpellAbility();
                if (ability.canTarget(spell)) result.add(spell);
            }
        }
        for (var entity : restrictions.getAllCandidates(ability)) {
            if (entity instanceof Card card && card.isInZone(ZoneType.Stack)) continue;
            if (ability.canTarget(entity)) result.add(entity);
        }
        return result;
    }

    private boolean hasTargets(SpellAbility root, Player actor) {
        for (var sa = root; sa != null; sa = sa.getSubAbility()) {
            sa.setActivatingPlayer(actor);
            if (sa.usesTargeting() && targets(sa).size() < sa.getMinTargets()) return false;
        }
        if (root.getApi() == forge.game.ability.ApiType.Charm) {
            return forge.game.ability.effects.CharmEffect.makePossibleOptions(root).stream().anyMatch(sa -> hasTargets(sa, actor));
        }
        return true;
    }

    private void selectTargets(SpellAbility root, Player actor) {
        for (var sa = root; sa != null; sa = sa.getSubAbility()) {
            if (!sa.usesTargeting()) continue;
            sa.setActivatingPlayer(actor);
            sa.resetTargets();
            if (!pickTargets(sa, actor)) throw new IllegalStateException("Forge rejected the selected targets.");
        }
    }

    private boolean pickTargets(SpellAbility ability, Player actor) {
        while (ability.canAddMoreTarget()) {
            List<Choice> choices = new ArrayList<>();
            for (GameObject target : targets(ability)) {
                if (ability.getTargets().contains(target)) continue;
                String anchor = target instanceof Card c ? cardId(c) : null;
                if (target instanceof SpellAbility spell) {
                    for (var entry : game.getStack()) {
                        if (entry.getSpellAbility() == spell) {
                            anchor = spell.isSpell() ? cardId(entry.getSourceCard()) : "s" + entry.getId();
                            break;
                        }
                    }
                }
                choices.add(new Choice("Target " + targetName(target), "target", anchor, target instanceof Player p ? p : null,
                        () -> ability.getTargets().add(target)));
            }
            if (choices.isEmpty()) break;
            Choice done = choice("Confirm targets", "option", null, null, null);
            if (ability.isTargetNumberValid()) choices.add(done);
            Choice selected = ask(actor, "Choose a target for " + publicName(ability.getHostCard()), choices);
            if (selected == done) break;
            selected.run();
        }
        return ability.isTargetNumberValid();
    }

    private static boolean announcesManaX(SpellAbility ability) {
        if (ability.getPayCosts() == null || !ability.costHasManaX()) return false;
        String x = ability.getSVar("X");
        return x.isEmpty() || x.equals("Count$xPaid");
    }

    private final class Controller extends PlayerControllerAi {
        private final Player seat;
        private Boolean keepAfterRedraw;
        private SpellAbility manualMana;

        Controller(Game match, Player seat, LobbyPlayerAi lobby) {
            super(match, seat, lobby);
            this.seat = seat;
        }

        @Override
        public boolean isAI() {
            // AI strategy deliberately saves targeted creatures from tapping to pay for a pump
            // spell. A human choosing that target can legally pay with the same mana creature.
            return !human(seat);
        }

        private boolean keep(int bottom) {
            var keep = choice("Keep hand", "option", null, null, null);
            if (bottom >= seat.getMaxHandSize()) return true;
            var redraw = choice("Mulligan", "option", null, null, null);
            String prompt = bottom == 0 ? "Keep your opening hand?" : "Keep this hand and put " + bottom + " on the bottom?";
            boolean kept = ask(seat, prompt, List.of(keep, redraw)) == keep;
            if (kept) history.add(seat.getName() + " kept their hand.");
            return kept;
        }

        @Override
        public boolean mulliganKeepHand(Player first, int count) {
            if (!human(seat)) return true;
            if (keepAfterRedraw == null) return keep(count);
            boolean answer = keepAfterRedraw;
            keepAfterRedraw = null;
            return answer;
        }

        @Override
        public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int count) {
            // In 2.0.13 the London service asks for bottom cards immediately
            // after each redraw, before its next keep callback.
            keepAfterRedraw = keep(count);
            return keepAfterRedraw ? pickCards(hand, count, "Bottom", "Choose a card for the bottom of your library") : CardCollection.EMPTY;
        }

        @Override
        public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int count) {
            if (!human(seat)) return super.chooseCardsToDiscardToMaximumHandSize(count);
            return pickCards(seat.getCardsIn(ZoneType.Hand), count, "Discard", "Discard to your maximum hand size");
        }

        @Override
        public CardCollection chooseCardsToDiscardFrom(Player owner, SpellAbility effect, CardCollection eligible,
                int min, int max, CardCollectionView shown) {
            if (!human(seat)) return super.chooseCardsToDiscardFrom(owner, effect, eligible, min, max, shown);
            if (seat == owner && min >= eligible.size()) return new CardCollection(eligible);
            // Forge supplies the cards this chooser may see separately from those they may select.
            revealedHand = seat == owner ? null : shown;
            try {
                return pickCards(eligible, min, max, "Discard", effect.getHostCard().getName()
                        + " — Choose from " + owner.getName() + "'s hand");
            } finally {
                revealedHand = null;
            }
        }

        @Override
        public CardCollectionView choosePermanentsToSacrifice(SpellAbility effect, int min, int max,
                CardCollectionView eligible, String type) {
            if (!human(seat)) return super.choosePermanentsToSacrifice(effect, min, max, eligible, type);
            if (min >= eligible.size()) return new CardCollection(eligible);
            return pickCards(eligible, min, max, "Sacrifice",
                    effect.getHostCard().getName() + " — Choose permanents to sacrifice");
        }

        private CardCollection pickCards(CardCollectionView available, int count, String verb, String prompt) {
            return pickCards(available, count, count, verb, prompt);
        }

        private CardCollection pickCards(CardCollectionView available, int min, int max, String verb, String prompt) {
            var picked = new CardCollection();
            int limit = Math.min(max, available.size());
            while (picked.size() < limit) {
                List<Choice> choices = new ArrayList<>();
                for (Card c : available) {
                    if (!picked.contains(c)) choices.add(choice(verb + " " + publicName(c), "card", c, null, () -> picked.add(c)));
                }
                var done = choice("Finish selection", "option", null, null, null);
                if (picked.size() >= min) choices.add(done);
                var selected = ask(seat, prompt + " (" + (picked.size() + 1) + " of " + limit + ")", choices);
                if (selected == done) break;
                selected.run();
            }
            return picked;
        }

        @Override
        public void declareAttackers(Player attacking, Combat combat) {
            PracticeCombat.attackers(ForgePractice.this, attacking, combat);
        }

        @Override
        public void declareBlockers(Player defending, Combat combat) {
            PracticeCombat.blockers(ForgePractice.this, defending, combat);
        }

        @Override
        public List<SpellAbility> orderSimultaneousSa(List<SpellAbility> abilities) {
            if (abilities.size() < 2) return abilities;
            if (!human(seat)) return super.orderSimultaneousSa(abilities);
            var remaining = new ArrayList<>(abilities);
            var resolutionOrder = new ArrayList<SpellAbility>();
            while (remaining.size() > 1) {
                List<Choice> options = new ArrayList<>();
                for (var ability : remaining) {
                    Card source = ability.getHostCard();
                    String label = "Resolve " + publicName(source);
                    if (!source.isFaceDown()) {
                        var trigger = ability.getTrigger();
                        String text = trigger == null ? ability.getDescription() : trigger.toString(true);
                        if (!text.isBlank()) label += " — " + text;
                    }
                    options.add(choice(label, "option", source, null, null));
                }
                var selected = ask(seat, "Choose which ability resolves next", options);
                resolutionOrder.add(remaining.remove(options.indexOf(selected)));
            }
            resolutionOrder.addAll(remaining);
            // PlayerControllerAi pushes the returned abilities in iteration order.
            java.util.Collections.reverse(resolutionOrder);
            return resolutionOrder;
        }

        @Override
        public void orderAndPlaySimultaneousSa(List<SpellAbility> abilities) {
            if (!human(seat)) {
                super.orderAndPlaySimultaneousSa(abilities);
                return;
            }
            for (var ability : orderSimultaneousSa(abilities)) {
                if (ability.isTrigger() && !ability.isCopied()
                        && (!ability.isOptionalTrigger() || optionalEffect(ability))
                        && !ability.getAllTargetChoices().isEmpty()) {
                    // The desktop human controller lets Forge set up each target group
                    // and its chooser. The AI controller picks trigger targets internally.
                    forge.game.player.PlaySpellAbility.playSpellAbility(this, seat, ability);
                } else {
                    super.orderAndPlaySimultaneousSa(List.of(ability));
                }
            }
        }

        private boolean optionalEffect(SpellAbility ability) {
            // Forge also flags some triggered costs as optional. Their payment
            // stays with the engine's cost handler.
            return ability instanceof forge.game.trigger.WrappedAbility wrapped
                    && wrapped.getTrigger().hasParam("OptionalDecider")
                    && !wrapped.getWrappedAbility().hasParam("Cost");
        }

        @Override
        public boolean confirmTrigger(forge.game.trigger.WrappedAbility ability) {
            if (!human(seat) || !optionalEffect(ability) || ability.getAllTargetChoices().isEmpty()) {
                return super.confirmTrigger(ability);
            }
            // Forge asks the decider during resolution, after opponents can respond.
            var use = choice("Use ability", "option", null, null, null);
            var decline = choice("Decline", "option", null, null, null);
            return ask(seat, "Use the triggered ability of " + publicName(ability.getHostCard()) + "?",
                    List.of(use, decline)) == use;
        }

        @Override
        public boolean chooseTargetsFor(SpellAbility ability) {
            if (!human(seat) || ability.isDividedAsYouChoose()) return super.chooseTargetsFor(ability);
            return pickTargets(ability, seat);
        }

        @Override
        public List<SpellAbility> chooseSpellAbilityToPlay() {
            if (!human(seat) || mode.equals("combat")) return null;
            if (mode.equals("library") && phases.getPhase().isBefore(PhaseType.MAIN1)) return null;
            boolean pending = !game.getStack().isEmpty();
            boolean responseExercise = mode.equals("response");
            if (responseExercise && !pending && (!phases.is(PhaseType.MAIN1, player) || seat != player
                    || !player.getCardsIn(ZoneType.Graveyard).isEmpty())) return null;
            List<Choice> choices = new ArrayList<>();
            Map<Choice, SpellAbility> plays = new java.util.IdentityHashMap<>();
            for (Card card : seat.getCardsIn(ZoneType.Hand)) {
                if (card.isLand() && seat.canPlayLand(card, false, null)) {
                    addPlay(card, new LandAbility(card, card.getCurrentState()), "Play " + card.getName(), choices, plays);
                }
                for (SpellAbility printed : card.getSpellAbilities()) {
                    if (printed.isSpell()) {
                        addPlay(card, printed.copy(), "Cast " + card.getName(), choices, plays);
                    }
                }
            }
            if (!responseExercise) {
                for (Card card : seat.getCardsIn(ZoneType.Battlefield)) {
                    for (SpellAbility ability : card.getNonManaAbilities()) {
                        if (ability.isActivatedAbility()) addActivation(card, ability, choices, plays);
                    }
                }
                for (Card card : seat.getCardsIn(ZoneType.Graveyard)) {
                    // Forge enumerates alternative costs and checks permission to play from this zone.
                    for (SpellAbility ability : card.getAllPossibleAbilities(seat, true)) {
                        if (ability.isSpell()) {
                            String label = (ability.isFlashback() ? "Flashback " : "Cast ") + publicName(card)
                                    + " from graveyard (" + ability.getPayCosts().toSimpleString() + ")";
                            addPlay(card, ability.copy(), label, choices, plays);
                        } else if (ability.isActivatedAbility() && !ability.isManaAbility() && !ability.isLandAbility()) {
                            addActivation(card, ability, choices, plays);
                        }
                    }
                }
            }
            if (choices.isEmpty()) return null;
            if (!responseExercise) {
                // Multi-ability sources can float mana in an existing decision window.
                // Untapped mana sources alone never make Forge stop at each priority.
                for (Card card : seat.getCardsIn(ZoneType.Battlefield)) {
                    var mana = card.getManaAbilities();
                    if (mana.isEmpty()) continue;
                    if (mana.size() > 1 || card.getNonManaAbilities().stream().anyMatch(SpellAbility::isActivatedAbility)) {
                        for (SpellAbility ability : mana) addActivation(card, ability, choices, plays);
                    }
                }
            }
            if (!responseExercise || pending) choices.add(choice("Pass priority", "pass", null, null, null));
            Choice selected = ask(seat, "Choose a play", choices);
            return plays.containsKey(selected) ? List.of(plays.get(selected)) : null;
        }

        private void addPlay(Card card, SpellAbility sa, String label, List<Choice> choices, Map<Choice, SpellAbility> plays) {
            sa.setActivatingPlayer(seat);
            if (!sa.canPlay() || !sa.isLandAbility() && !canPayWithTargets(sa)) return;
            Choice c = choice(label, sa.isActivatedAbility() && !sa.isLandAbility() ? "ability" : "card", card, null, null);
            choices.add(c);
            plays.put(c, sa);
        }

        private void addActivation(Card card, SpellAbility ability, List<Choice> choices, Map<Choice, SpellAbility> plays) {
            // Activation limits and paid costs belong to this Forge ability instance.
            addPlay(card, ability, ability.getDescription().replace("CARDNAME", publicName(card)), choices, plays);
        }

        private boolean canPayWithTargets(SpellAbility ability) {
            if (announcesManaX(ability)) return !payableXValues(ability, 0, 1).isEmpty();
            return ComputerUtilCost.canPayCost(ability, seat, false) && hasTargets(ability, seat);
        }

        private List<Integer> payableXValues(SpellAbility ability, int start, int limit) {
            // Probe a copy. Activated abilities on permanents are reused across priority windows.
            SpellAbility probe = ability.copy();
            var bounds = forge.game.ability.AbilityUtils.getAnnouncementBounds(probe, "X");
            List<Integer> values = new ArrayList<>();
            for (int x = Math.max(start, bounds.getMinimum()); x <= bounds.getMaximum(); x++) {
                probe.setXManaCostPaid(x);
                if (!forge.ai.ComputerUtilMana.canPayManaCost(probe, seat, x, false)) break;
                if (ComputerUtilCost.canPayCost(probe, seat, false) && hasTargets(probe, seat)) {
                    values.add(x);
                    if (values.size() == limit) break;
                }
                if (x == bounds.getMaximum()) break;
            }
            return values;
        }

        private void chooseManaX(SpellAbility play) {
            // Show one page at a time even if a mana engine can pay a very large X.
            int pageSize = 10;
            var starts = new ArrayList<>(List.of(0));
            while (true) {
                List<Integer> values = payableXValues(play, starts.get(starts.size() - 1), pageSize + 1);
                List<Choice> options = new ArrayList<>();
                values.stream().limit(pageSize).forEach(x -> options.add(
                        choice("X = " + x, "option", null, null, () -> play.setXManaCostPaid(x))));
                Choice lower = choice("Lower X values", "option", null, null, null);
                Choice higher = choice("Higher X values", "option", null, null, null);
                if (starts.size() > 1) options.add(lower);
                if (values.size() > pageSize) options.add(higher);
                Choice answer = ask(seat, "Choose X for " + publicName(play.getHostCard()), options);
                if (answer == higher) starts.add(values.get(pageSize));
                else if (answer == lower) starts.remove(starts.size() - 1);
                else {
                    answer.run();
                    return;
                }
            }
        }

        @Override
        public boolean playChosenSpellAbility(SpellAbility sa) {
            if (sa.isLandAbility()) return super.playChosenSpellAbility(sa);
            var withCosts = sa;
            if (sa.isSpell()) {
                for (var extra : forge.game.GameActionUtil.getOptionalCostValues(sa)) {
                    var payable = forge.game.GameActionUtil.addOptionalCosts(withCosts, List.of(extra));
                    if (!payable.canPlay() || !canPayWithTargets(payable)) continue;
                    var pay = choice(extra.toString(), "option", null, null, null);
                    var skip = choice("Skip optional cost", "option", null, null, null);
                    if (ask(seat, "Optional cost for " + sa.getHostCard().getName(), List.of(pay, skip)) == pay) withCosts = payable;
                }
            }
            final var play = withCosts;
            if (announcesManaX(play)) chooseManaX(play);
            if (play.isManaAbility()) {
                manualMana = play;
                play.getManaPart().clearExpressChoice();
            }
            try {
                if (!ComputerUtil.handlePlayingSpellAbility(seat, play, () -> selectTargets(play, seat))) {
                    throw new IllegalStateException("Forge could not complete the cost or choices for " + play.getHostCard().getName() + ".");
                }
            } finally {
                manualMana = null;
            }
            return true;
        }

        @Override
        public byte chooseColor(String prompt, SpellAbility ability, forge.card.ColorSet colors) {
            if (manualMana == null || ability != manualMana || colors.countColors() <= 1) {
                return super.chooseColor(prompt, ability, colors);
            }
            List<Choice> options = new ArrayList<>();
            List<Byte> masks = new ArrayList<>();
            for (var color : colors) {
                options.add(choice(color.getName(), "option", null, null, null));
                masks.add(color.getColorMask());
            }
            return masks.get(options.indexOf(ask(seat, prompt, options)));
        }

        @Override
        public String chooseSomeType(String type, SpellAbility ability, java.util.Collection<String> valid, boolean optional) {
            if (!human(seat) || valid.isEmpty()) return super.chooseSomeType(type, ability, valid, optional);
            List<Choice> options = new ArrayList<>();
            valid.stream().sorted().forEach(name -> options.add(choice(name, "type", null, null, null)));
            Choice skip = choice("Skip", "option", null, null, null);
            if (optional) options.add(skip);
            String prompt = "Choose a " + type.toLowerCase(java.util.Locale.ROOT) + " type";
            Choice selected = ask(seat, ability == null ? prompt : prompt + " for " + publicName(ability.getHostCard()), options);
            return selected == skip ? null : selected.label();
        }

        @Override
        public Card chooseSingleCardForZoneChange(ZoneType destination, List<ZoneType> origins, SpellAbility effect,
                CardCollection options, forge.game.player.DelayedReveal delayedReveal, String title, boolean optional, Player decider) {
            if (!human(seat) || !origins.contains(ZoneType.Library)) {
                return super.chooseSingleCardForZoneChange(destination, origins, effect, options, delayedReveal, title, optional, decider);
            }
            if (delayedReveal != null) reveal(delayedReveal);
            history.add(seat.getName() + " searched a library.");
            return library.choose(seat, effect, options, title, optional);
        }

        @Override
        public List<Card> chooseCardsForZoneChange(ZoneType destination, List<ZoneType> origins, SpellAbility effect,
                CardCollection options, int min, int max, forge.game.player.DelayedReveal delayedReveal, String title, Player decider) {
            if (!human(seat) || !origins.contains(ZoneType.Library)) {
                return super.chooseCardsForZoneChange(destination, origins, effect, options, min, max, delayedReveal, title, decider);
            }
            if (delayedReveal != null) reveal(delayedReveal);
            history.add(seat.getName() + " searched a library.");
            return library.chooseMany(seat, effect, options, min, max, title);
        }

        @Override
        public boolean confirmAction(SpellAbility effect, forge.game.player.PlayerActionConfirmMode mode, String message,
                List<String> options, Card display, Map<String, Object> params) {
            return library.confirmedFinish(effect, mode) || super.confirmAction(effect, mode, message, options, display, params);
        }

        @Override
        public void reveal(CardCollectionView cards, ZoneType zone, Player owner, String message, boolean revealDialog) {
            super.reveal(cards, zone, owner, message, revealDialog);
            // Forge calls this on the actual recipients. Its private search preview uses DelayedReveal instead.
            if (owner != seat) library.revealTo(seat, cards);
        }

        @Override
        public org.apache.commons.lang3.tuple.ImmutablePair<CardCollection, CardCollection> arrangeForScry(CardCollection cards) {
            return human(seat) ? library.arrange(seat, cards, false) : super.arrangeForScry(cards);
        }

        @Override
        public org.apache.commons.lang3.tuple.ImmutablePair<CardCollection, CardCollection> arrangeForSurveil(CardCollection cards) {
            return human(seat) ? library.arrange(seat, cards, true) : super.arrangeForSurveil(cards);
        }

        @Override
        public List<forge.game.spellability.AbilitySub> chooseModeForAbility(SpellAbility sa,
                List<forge.game.spellability.AbilitySub> modes, int min, int max, boolean repeats) {
            List<forge.game.spellability.AbilitySub> chosen = new ArrayList<>();
            while (chosen.size() < max) {
                List<Choice> choices = new ArrayList<>();
                for (var ability : modes) {
                    if ((repeats || !chosen.contains(ability)) && hasTargets(ability, seat)) {
                        String text = ability.getDescription().replace("CARDNAME", sa.getHostCard().getName());
                        choices.add(choice(text, "option", null, null, () -> chosen.add(ability)));
                    }
                }
                var done = choice("Confirm modes", "option", null, null, null);
                if (chosen.size() >= min) choices.add(done);
                if (choices.isEmpty()) return null;
                var selected = ask(seat, "Choose a mode for " + sa.getHostCard().getName(), choices);
                if (selected == done) break;
                selected.run();
            }
            return chosen;
        }
    }
}
