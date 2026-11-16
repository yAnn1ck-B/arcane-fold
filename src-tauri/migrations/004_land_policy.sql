-- Replace only the previous default land slot. Explicitly customized pack
-- compositions, owned cards, decks, balances, and history remain untouched.
UPDATE settings
SET value = json_set(value, '$.league.booster.basicLands', 0)
WHERE key = 'app'
  AND CASE WHEN json_valid(value) THEN
    json_extract(value, '$.league.booster.commons') = 10
    AND json_extract(value, '$.league.booster.uncommons') = 3
    AND json_extract(value, '$.league.booster.rareSlots') = 1
    AND json_extract(value, '$.league.booster.basicLands') = 1
  ELSE 0 END;
