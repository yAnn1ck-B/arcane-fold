// Shares a source-file launch unit with ForgeBoltTrial and PracticeCombat.
final class ForgePractice {
    final String mode;
    final Player player;
    final Player opponent;
    private final Game game;
    private final PhaseHandler phases;
    private final Path scratch;
    private final BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    private int decision;
    private int yieldTurn = -1;

    ForgePractice(String mode, Path scratch) {
        this.mode = mode;
        this.scratch = scratch;
        game = new Match(new GameRules(GameType.Constructed), List.of(seat("Player"), seat("Opponent")),
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

    private void prepareDeck() throws IOException {
        boolean main = false;
        var catalog = StaticData.instance();
        for (String row : Files.readAllLines(scratch.resolve("practice.dck"), StandardCharsets.UTF_8)) {
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
                    player.getZone(ZoneType.Library).add(CardFactory.getCard(paper, player, game));
                }
            }
        }
        if (player.getCardsIn(ZoneType.Library).size() < player.getStartingHandSize()) {
            throw new IllegalArgumentException("Practice needs at least seven main-deck cards.");
        }
        for (int i = 0; i < 60; i++) put("Island", opponent, ZoneType.Library);
        game.setAge(GameStage.Mulligan);
        for (Player p : game.getPlayers()) {
            p.shuffle(null);
            p.drawCards(p.getStartingHandSize());
        }
        catalog.setMulliganRule(forge.MulliganDefs.MulliganRule.London);
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
                case "combat" -> PracticeCombat.setup(this);
                case "deck" -> prepareDeck();
                default -> throw new IllegalArgumentException("Unknown practice scenario.");
            }
            game.setAge(GameStage.Play);
            phases.setupFirstTurn(player, null);
            int steps = 0;
            while (!game.isGameOver()) {
                if (mode.equals("combat") && phases.getPhase() == PhaseType.MAIN2) {
                    emit(player, "Combat complete", List.of(), true);
                    return;
                }
                if (mode.equals("response") && game.getStack().isEmpty()
                        && !player.getCardsIn(ZoneType.Graveyard).isEmpty()) {
                    boolean countered = !opponent.getCardsIn(ZoneType.Graveyard).isEmpty();
                    emit(player, countered ? "Counterspell countered Lightning Bolt." : "Lightning Bolt resolved.", List.of(), true);
                    return;
                }
                int previous = decision;
                phases.mainLoopStep();
                steps = previous == decision ? steps + 1 : 0;
                if (steps > 512) throw new IllegalStateException("Forge did not reach the next practice decision.");
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
                if (choiceId(i).equals(selected)) return choices.get(i);
            }
            throw new IllegalArgumentException("This choice is no longer available.");
        } catch (IOException ex) {
            throw new IllegalStateException("Could not exchange the Forge decision.", ex);
        }
    }

    private String choiceId(int index) { return "p" + decision + "_" + index; }
    private String seatId(Player p) { return p == opponent ? "opponent" : "player"; }
    private String cardId(Card c) { return "c" + c.getId(); }

    private Map<String, Object> cardState(Card card) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", cardId(card));
        out.put("name", card.getName());
        out.put("setCode", card.getSetCode());
        if (card.getPaperCard() != null) out.put("collectorNumber", card.getPaperCard().getCollectorNumber());
        out.put("tapped", card.isTapped());
        if (card.isCreature()) {
            out.put("power", card.getNetPower());
            out.put("toughness", card.getNetToughness());
        }
        Combat combat = phases.getCombat();
        if (combat != null) {
            if (combat.isAttacking(card)) out.put("attacking", true);
            if (combat.getAllBlockers().contains(card)) {
                out.put("blocking", true);
                out.put("target", String.join(", ", combat.getAttackersBlockedBy(card).stream().map(Card::getName).toList()));
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
                "graveyard", p.getCardsIn(ZoneType.Graveyard).stream().map(this::cardState).toList());
    }

    private static String targetName(GameObject obj) {
        if (obj instanceof SpellAbility spell) return spell.getHostCard().getName();
        if (obj instanceof Player p) return p.getName();
        return ((Card)obj).getName();
    }

    private void emit(Player actor, String prompt, List<Choice> choices, boolean finished) throws IOException {
        var stack = new ArrayList<Map<String, Object>>();
        for (var instance : game.getStack()) {
            var out = cardState(instance.getSourceCard());
            var spell = instance.getSpellAbility();
            if (!spell.isSpell()) {
                out.put("id", "s" + instance.getId());
                out.put("description", spell.getStackDescription());
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
        var state = Map.of("stage", finished ? "finished" : "decision", "prompt", prompt,
                "actor", seatId(actor), "active", seatId(phases.getPlayerTurn()), "turn", phases.getTurn(),
                "phase", phases.getPhase() == null ? "Opening hand" : phases.getPhase().nameForUi,
                "players", Map.of("player", board(player, true), "opponent", board(opponent, actor == opponent && mode.equals("response"))),
                "stack", stack, "choices", options);
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
            while (sa.canAddMoreTarget()) {
                List<Choice> choices = new ArrayList<>();
                final var selecting = sa;
                for (GameObject target : targets(sa)) {
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
                            () -> selecting.getTargets().add(target)));
                }
                Choice done = choice("Confirm targets", "option", null, null, null);
                if (sa.isTargetNumberValid()) {
                    if (choices.isEmpty()) break;
                    choices.add(done);
                }
                Choice selected = ask(actor, "Choose a target for " + root.getHostCard().getName(), choices);
                if (selected == done) break;
                selected.run();
            }
            if (!sa.isTargetNumberValid()) throw new IllegalStateException("Forge rejected the selected targets.");
        }
    }

    private final class Controller extends PlayerControllerAi {
        private final Player seat;
        private Boolean keepAfterRedraw;

        Controller(Game match, Player seat, LobbyPlayerAi lobby) {
            super(match, seat, lobby);
            this.seat = seat;
        }

        private boolean keep(int bottom) {
            var keep = choice("Keep hand", "option", null, null, null);
            if (bottom >= seat.getMaxHandSize()) return true;
            var redraw = choice("Mulligan", "option", null, null, null);
            String prompt = bottom == 0 ? "Keep your opening hand?" : "Keep this hand and put " + bottom + " on the bottom?";
            return ask(seat, prompt, List.of(keep, redraw)) == keep;
        }

        @Override
        public boolean mulliganKeepHand(Player first, int count) {
            if (seat == opponent) return true;
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
            if (seat == opponent) return super.chooseCardsToDiscardToMaximumHandSize(count);
            return pickCards(seat.getCardsIn(ZoneType.Hand), count, "Discard", "Discard to your maximum hand size");
        }

        private CardCollectionView pickCards(CardCollectionView available, int count, String verb, String prompt) {
            var picked = new CardCollection();
            while (picked.size() < count) {
                List<Choice> choices = new ArrayList<>();
                for (Card c : available) {
                    if (!picked.contains(c)) choices.add(choice(verb + " " + c.getName(), "card", c, null, () -> picked.add(c)));
                }
                ask(seat, prompt + " (" + (picked.size() + 1) + " of " + count + ")", choices).run();
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
        public List<SpellAbility> chooseSpellAbilityToPlay() {
            boolean deck = mode.equals("deck");
            if (mode.equals("combat") || deck && seat == opponent) return null;
            boolean pending = !game.getStack().isEmpty();
            if (!pending && (!phases.is(PhaseType.MAIN1, seat) || seat == opponent || yieldTurn == phases.getTurn())) return null;
            if (mode.equals("response") && !pending && !player.getCardsIn(ZoneType.Graveyard).isEmpty()) return null;
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
            if (deck) {
                for (Card card : seat.getCardsIn(ZoneType.Battlefield)) {
                    for (SpellAbility ability : card.getNonManaAbilities()) {
                        if (ability.isActivatedAbility()) {
                            String label = ability.getDescription().replace("CARDNAME", card.getName());
                            addPlay(card, ability.copy(), label, choices, plays);
                        }
                    }
                }
            }
            if (pending && !deck && game.getStack().peekAbility().getActivatingPlayer() == seat && choices.isEmpty()) return null;
            if (pending || deck) choices.add(choice(pending ? "Pass priority" : "Next turn", "pass", null, null, null));
            if (choices.isEmpty()) return null;
            Choice selected = ask(seat, pending ? seat.getName() + " has priority" : "Choose a play", choices);
            if (plays.containsKey(selected)) return List.of(plays.get(selected));
            if (deck && !pending) yieldTurn = phases.getTurn();
            return null;
        }

        private void addPlay(Card card, SpellAbility sa, String label, List<Choice> choices, Map<Choice, SpellAbility> plays) {
            sa.setActivatingPlayer(seat);
            if (!sa.canPlay() || !sa.isLandAbility() && (!ComputerUtilCost.canPayCost(sa, seat, false) || !hasTargets(sa, seat))) return;
            Choice c = choice(label, "card", card, null, null);
            choices.add(c);
            plays.put(c, sa);
        }

        @Override
        public boolean playChosenSpellAbility(SpellAbility sa) {
            if (sa.isLandAbility()) return super.playChosenSpellAbility(sa);
            var withCosts = sa;
            if (sa.isSpell()) {
                for (var extra : forge.game.GameActionUtil.getOptionalCostValues(sa)) {
                    var payable = forge.game.GameActionUtil.addOptionalCosts(withCosts, List.of(extra));
                    if (!payable.canPlay() || !ComputerUtilCost.canPayCost(payable, seat, false)) continue;
                    var pay = choice(extra.toString(), "option", null, null, null);
                    var skip = choice("Skip optional cost", "option", null, null, null);
                    if (ask(seat, "Optional cost for " + sa.getHostCard().getName(), List.of(pay, skip)) == pay) withCosts = payable;
                }
            }
            final var play = withCosts;
            if (!ComputerUtil.handlePlayingSpellAbility(seat, play, () -> selectTargets(play, seat))) {
                throw new IllegalStateException("Forge could not complete the cost or choices for " + play.getHostCard().getName() + ".");
            }
            return true;
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
