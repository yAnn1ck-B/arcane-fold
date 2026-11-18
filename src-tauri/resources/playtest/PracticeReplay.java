// Verify state that is deliberately absent from the public board. Only the digest leaves the JVM.
final class PracticeReplay {
    static String fingerprint(Player one, Player two) throws IOException {
        java.security.MessageDigest digest;
        try {
            digest = java.security.MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
        var stream = new java.security.DigestOutputStream(java.io.OutputStream.nullOutputStream(), digest);
        try (var out = new java.io.ObjectOutputStream(stream)) {
            // Random's serialized state also preserves its cached Gaussian value.
            out.writeObject(forge.util.MyRandom.getRandom());
            for (Player seat : List.of(one, two)) {
                out.writeInt(seat.getLandsPlayedThisTurn());
                out.writeInt(seat.getSpellsCastThisTurn());
                // Colors as well as totals matter for later payments.
                for (byte color : forge.card.MagicColor.WUBRGC) out.writeInt(seat.getManaPool().getAmountOfColor(color));
                for (ZoneType zone : Player.ALL_ZONES) {
                    var playerZone = seat.getZone(zone);
                    if (playerZone == null) {
                        out.writeInt(-1);
                        continue;
                    }
                    var cards = playerZone.getCards(false);
                    out.writeInt(cards.size());
                    for (Card card : cards) {
                        var printed = card.getPaperCard();
                        out.writeInt(card.getId());
                        out.writeUTF(String.valueOf(printed == null ? card.getName() : printed.getName()));
                        out.writeUTF(String.valueOf(card.getSetCode()));
                        out.writeUTF(String.valueOf(printed == null ? "" : printed.getCollectorNumber()));
                        if (zone != ZoneType.Battlefield) continue;
                        out.writeBoolean(card.isSick());
                        out.writeBoolean(card.isPhasedOut());
                        out.writeInt(card.getAttachedTo() == null ? -1 : card.getAttachedTo().getId());
                        var abilities = card.getSpellAbilities();
                        out.writeInt(abilities.size());
                        for (SpellAbility ability : abilities) {
                            out.writeInt(ability.getActivationsThisTurn());
                            out.writeInt(ability.getActivationsThisGame());
                        }
                    }
                }
            }
        }
        return java.util.HexFormat.of().formatHex(digest.digest());
    }
}
