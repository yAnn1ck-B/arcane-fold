import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedAccounts, signIn } from '../accounts.mjs';

// The caller owns an isolated schema and an open transaction.
export async function localTestPlayers(db) {
  const dir = await mkdtemp(join(tmpdir(), 'arcane-fold-test-players-'));
  try {
    await seedAccounts(db, join(dir, 'logins.json'));
    const yannick = await signIn(db, { email: 'yannick@arcane-fold.test' }, { local: true });
    const jef = await signIn(db, { email: 'jef@arcane-fold.test' }, { local: true });
    return { yannick: yannick.playerId, jef: jef.playerId };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
