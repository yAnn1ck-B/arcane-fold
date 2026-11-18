/** A fixed, ephemeral match against the locally installed Forge 2.0.13 engine. */
class ForgeBoltTrial {
    private final Game game;
    private final Player player;
    private final Player opponent;
    private final PhaseHandler phases;
    private final ForgeHistory history;
    private SpellAbility spell;
    private String stage = "ready";

    // Only this fixture's two seats are supported. A call to the phase loop is
    // an explicit yield from the current seat; no AI chooses either player's moves.
    private static RegisteredPlayer seat(String name) {
        LobbyPlayerAi lobby = new LobbyPlayerAi(name, Set.of()) {
            @Override
            public Player createIngamePlayer(Game game, int id) {
                Player seat = new Player(getName(), game, id);
                seat.setFirstController(new PlayerControllerAi(game, seat, this) {
                    @Override
                    public List<SpellAbility> chooseSpellAbilityToPlay() {
                        return null; // Forge's controller contract for passing.
                    }
                });
                return seat;
            }
        };
        return new RegisteredPlayer(new Deck(name)).setPlayer(lobby);
    }

    private ForgeBoltTrial() {
        game = new Match(new GameRules(GameType.Constructed), List.of(seat("Player"), seat("Opponent")),
                "Lightning Bolt trial").createGame();
        player = game.getPlayers().get(0);
        opponent = game.getPlayers().get(1);
        for (Player seat : game.getPlayers()) {
            seat.setStartingLife(20);
            seat.setLife(20, null);
        }
        for (String name : List.of("Mountain", "Lightning Bolt")) {
            StaticData.instance().attemptToLoadCard(name);
            Card card = CardFactory.getCard(StaticData.instance().getCommonCards().getCard(name), player, game);
            player.getZone(ZoneType.Hand).add(card);
        }
        game.setStartingPlayer(player);
        game.setAge(GameStage.Play);
        phases = game.getPhaseHandler();
        history = new ForgeHistory(game);
        phases.setupFirstTurn(player, null);
        for (int step = 0; step < 20 && phases.getPhase() != PhaseType.MAIN1; step++) {
            phases.mainLoopStep();
        }
        require(phases.is(PhaseType.MAIN1, player) && phases.getPriorityPlayer() == player,
                "Forge did not reach the first main phase.");
    }

    private Card inHand(String name) {
        return player.getCardsIn(ZoneType.Hand).stream().filter(c -> name.equals(c.getName()))
                .findFirst().orElseThrow(() -> new IllegalStateException(name + " is not in hand."));
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalStateException(message);
    }

    private void act(String action) {
        switch (action) {
            case "playMountain" -> {
                require(stage.equals("ready"), "Play Mountain from the opening hand.");
                Card land = inHand("Mountain");
                require(player.canPlayLand(land, false, null), "Forge rejected the land play.");
                require(player.playLand(land, null) != null, "Forge could not play Mountain.");
                stage = "landPlayed";
            }
            case "castBolt" -> {
                require(stage.equals("landPlayed"), "Play Mountain before casting Lightning Bolt.");
                spell = inHand("Lightning Bolt").getFirstSpellAbility();
                spell.setActivatingPlayer(player);
                require(spell.canPlay(), "Forge rejected Lightning Bolt at this time.");
                require(ComputerUtilCost.canPayCost(spell, player, false), "Forge could not pay for Lightning Bolt.");
                stage = "chooseTarget";
            }
            case "targetOpponent", "targetPlayer" -> {
                require(stage.equals("chooseTarget"), "Choose a target while casting Lightning Bolt.");
                Player target = action.equals("targetOpponent") ? opponent : player;
                require(spell.canTarget(target) && spell.getTargets().add(target) && spell.isTargetNumberValid(),
                        "Forge rejected the selected target.");
                require(ComputerUtil.playStack(spell, player, game), "Forge could not pay for and cast Lightning Bolt.");
                require(game.getStack().size() == 1, "Lightning Bolt did not reach the stack.");
                // The caster yields after casting. The phase handler determines
                // the next seat and whether the spell should resolve.
                phases.mainLoopStep();
                require(phases.getPriorityPlayer() == opponent && game.getStack().size() == 1,
                        "Forge did not offer the opponent priority.");
                stage = "opponentPriority";
            }
            case "passPriority" -> {
                require(stage.equals("opponentPriority") && phases.getPriorityPlayer() == opponent,
                        "The opponent does not have priority.");
                history.pass(opponent);
                phases.mainLoopStep();
                require(game.getStack().isEmpty() && !player.getCardsIn(ZoneType.Graveyard).isEmpty(),
                        "Forge did not finish resolving Lightning Bolt.");
                stage = "resolved";
            }
            default -> throw new IllegalArgumentException("Unknown trial action.");
        }
    }

    private List<String> names(ZoneType zone) {
        return player.getCardsIn(zone).stream().map(Card::getName).toList();
    }

    private void emit() throws IOException {
        List<String> legalTargets = new ArrayList<>();
        if (stage.equals("chooseTarget")) {
            if (spell.canTarget(player)) legalTargets.add("player");
            if (spell.canTarget(opponent)) legalTargets.add("opponent");
        }
        List<String> stack = new ArrayList<>();
        game.getStack().forEach(entry -> stack.add(entry.getSourceCard().getName()));
        String target = null;
        if (!game.getStack().isEmpty()) {
            SpellAbility top = game.getStack().peekAbility();
            if (top.isTargeting(opponent)) target = "opponent";
            if (top.isTargeting(player)) target = "player";
        }
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("stage", stage);
        state.put("history", history.entries);
        state.put("playerLife", player.getLife());
        state.put("opponentLife", opponent.getLife());
        state.put("hand", names(ZoneType.Hand));
        state.put("battlefield", names(ZoneType.Battlefield));
        state.put("opponentBattlefield", opponent.getCardsIn(ZoneType.Battlefield).stream().map(Card::getName).toList());
        state.put("graveyard", names(ZoneType.Graveyard));
        state.put("stack", stack);
        state.put("mountainTapped", player.getCardsIn(ZoneType.Battlefield).stream().anyMatch(Card::isTapped));
        state.put("mana", player.getManaPool().totalMana());
        state.put("legalTargets", legalTargets);
        state.put("target", target);
        state.put("replayState", ForgeReplay.fingerprint(player, opponent));
        var json = new StringWriter();
        new JsonObjectWriter(json, 5).value(NoOpLogger.getInstance(), state);
        System.out.println("GAME_STATE " + json);
        System.out.flush();
    }

    public static void main(String[] args) {
        try {
            ForgeGame.loadForge(Path.of(args[0]), Path.of(args[1]), args.length > 2 && args[2].equals("deck"));
            if (args.length > 3) forge.util.MyRandom.setRandom(new java.util.Random(Long.parseLong(args[3])));
            if (args.length > 2 && !args[2].equals("bolt")) {
                new GuidedPosition(args[2], Path.of(args[1])).run();
                System.exit(0);
            }
            ForgeBoltTrial trial = new ForgeBoltTrial();
            trial.emit();
            var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            for (String action; (action = ForgeManual.readAction(input, () ->
                    new ForgeManual(trial.game, trial.player).snapshot(trial.opponent,
                            new String[]{"Lightning Bolt", "Opponent"}, new boolean[]{true, true}, new int[]{0, 0}, Map.of()))) != null;) {
                trial.act(action);
                trial.emit();
            }
        } catch (Exception | LinkageError ex) {
            Throwable cause = ex;
            while (cause.getCause() != null) cause = cause.getCause();
            String message = cause.getMessage();
            System.out.println("GAME_ERROR " + (message == null ? cause.getClass().getSimpleName()
                    : message.replace('\n', ' ').replace('\r', ' ')));
            ex.printStackTrace(System.err);
            System.exit(1);
        }
    }
}

// Guided positions exist only in the native integration-test source unit.
final class GuidedPosition extends ForgeMatch {
    private final String mode;
    GuidedPosition(String mode, Path scratch) {
        super(scratch, true);
        this.mode = mode;
    }

    @Override
    boolean human(Player seat) {
        // This fixed library exercise begins with the first main-phase decision.
        return !("library".equals(mode) && phases.getPhase() != null && phases.getPhase().isBefore(PhaseType.MAIN1));
    }

    static void librarySetup(ForgeMatch practice) {
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

    static void combatSetup(ForgeMatch practice, String mode) {
        practice.put("Grizzly Bears", practice.player, ZoneType.Battlefield).setSickness(false);
        practice.put("Runeclaw Bear", practice.opponent, ZoneType.Battlefield).setSickness(false);
        if (mode.equals("growth")) {
            practice.put("Forest", practice.player, ZoneType.Battlefield);
            practice.put("Giant Growth", practice.player, ZoneType.Hand);
        }
    }

    @Override
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
                case "combat", "growth" -> combatSetup(this, mode);
                case "library" -> librarySetup(this);
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

}
