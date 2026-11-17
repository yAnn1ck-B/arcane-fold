#!/usr/bin/env python3
"""Run the release AppImage against temporary Linux profile directories only."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

IDENTIFIER = 'com.eternalleague.desktop'
PROBE = 'phase5-persistence-probe'
DEADLINE_SECONDS = 60
REWARD_LEDGER_KEY = 'league_reward_entitlements_v1'
WEEK_SECONDS = 604800
RARITIES = ('common', 'uncommon', 'rare', 'mythic')


def reward_period(rules, now):
    return max(0, (now - rules['startedAt']) // WEEK_SECONDS)


def pack_set(rules, week):
    selected = rules['enabledSets'][0].lower()
    for expansion in sorted(rules['expansionSchedule'], key=lambda entry: entry['week']):
        if expansion['week'] <= week:
            selected = expansion['code'].lower()
    return selected


def validate_fresh_profile(db, rules, first_period, now):
    """Validate a gate-waiting profile or its legitimate first-use rewards.

    Call inside a read transaction so an atomic native grant cannot split the
    reads. The caller compares snapshots to detect changes on repeat launches.
    """
    for table in ['collection', 'decks', 'deck_cards', 'booster_history', 'progression_operations']:
        if db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]:
            raise RuntimeError(f'Fresh production profile contains unexpected {table} progress.')
    states = db.execute('SELECT id,started_at,available_packs,last_claimed_period FROM league_state ORDER BY id').fetchall()
    wildcards = dict(db.execute('SELECT rarity,quantity FROM wildcards'))
    queue = db.execute('SELECT id,set_code,source,earned_period,priority,remaining FROM booster_pack_queue ORDER BY id').fetchall()
    balances = dict(db.execute('SELECT set_code,quantity FROM set_booster_balances'))
    claims = db.execute('SELECT set_code,week,quantity,claimed_at FROM expansion_reward_claims ORDER BY set_code').fetchall()
    saved = db.execute('SELECT value FROM settings WHERE key=?', (REWARD_LEDGER_KEY,)).fetchone()
    if not states:
        if (wildcards != dict.fromkeys(RARITIES, 0) or queue or balances or claims or saved):
            raise RuntimeError('Uninitialized production profile contains unexpected reward data.')
        return None
    if len(states) != 1 or states[0][0:2] != (1, rules['startedAt']):
        raise RuntimeError('The first-use league does not use the production shared start.')
    _, _, general_packs, credited = states[0]
    if now < rules['startedAt'] or not first_period <= credited <= reward_period(rules, now):
        raise RuntimeError('First-use rewards contain an unexpected credited period.')
    expected_wildcards = {
        rarity: rules['startingWildcards'][rarity] + rules['weeklyWildcards'][rarity]
        * (credited // rules['wildcardRewardIntervals'][rarity])
        for rarity in RARITIES
    }
    expected_ledger = {
        'version': 1, 'startingPacks': rules['startingPacks'],
        'weeklyPacks': rules['weeklyPacks'], 'startingWildcards': rules['startingWildcards'],
    }
    ledger = json.loads(saved[0]) if saved else None
    if wildcards != expected_wildcards or ledger != expected_ledger:
        raise RuntimeError('First-use wildcards or entitlement ledger differ from the built-in rules.')
    if general_packs != rules['startingPacks'] + credited * rules['weeklyPacks']:
        raise RuntimeError('First-use general packs differ from the built-in rewards.')
    due = {entry['code'].lower(): (entry['week'], entry['bonusPacks'])
           for entry in rules['expansionSchedule']
           if entry['week'] <= credited and entry['bonusPacks'] > 0}
    if balances != {code: amount for code, (_, amount) in due.items()}:
        raise RuntimeError('First-use reserved pack balances differ from the expansion calendar.')
    if [(code, week, amount) for code, week, amount, _ in claims] != sorted(
            (code, week, amount) for code, (week, amount) in due.items()):
        raise RuntimeError('First-use expansion claims differ from the expansion calendar.')
    expected_queue = {('general', pack_set(rules, 0)): rules['startingPacks']}
    for week in range(1, credited + 1):
        key = ('general', pack_set(rules, week))
        expected_queue[key] = expected_queue.get(key, 0) + rules['weeklyPacks']
    expected_queue.update({('bonus', code): amount for code, (_, amount) in due.items()})
    actual_queue = {}
    for _, code, source, earned, priority, remaining in queue:
        if remaining <= 0 or not 0 <= earned <= credited:
            raise RuntimeError('Fresh reward queue contains a spent or invalid grant.')
        if source == 'general':
            if code != pack_set(rules, earned) or priority != (1 if earned else 0):
                raise RuntimeError('Fresh general queue contains an incorrect expansion or order.')
        elif source != 'bonus' or due.get(code) != (earned, remaining) or priority != 0:
            raise RuntimeError('Fresh reserved queue contains an incorrect expansion grant.')
        key = (source, code)
        actual_queue[key] = actual_queue.get(key, 0) + remaining
    if actual_queue != {key: amount for key, amount in expected_queue.items() if amount}:
        raise RuntimeError('The fresh chronological queue differs from earned pack balances.')
    return {'period': credited, 'state': states, 'wildcards': wildcards,
            'queue': queue, 'balances': balances, 'claims': claims, 'ledger': ledger}


def clean_error(value, root=None):
    text = str(value)
    if root:
        text = text.replace(str(root), '<isolated-profile>')
    text = re.sub(r'(?i)(bearer\s+|token[=:]\s*|password[=:]\s*)[^\s]+', r'\1<redacted>', text)
    return text[-2500:]


def run(source):
    if sys.platform != 'linux':
        raise RuntimeError('This smoke test runs only on Linux.')
    source = source.resolve(strict=True)
    if not source.is_file() or source.suffix != '.AppImage':
        raise RuntimeError('Pass exactly one built .AppImage file.')
    runner_temp = Path(os.environ.get('RUNNER_TEMP', tempfile.gettempdir())).resolve()
    runner_temp.mkdir(parents=True, exist_ok=True)
    expected_schema = max(int(file.name.split('_', 1)[0]) for file in Path('src-tauri/migrations').glob('[0-9][0-9][0-9]_*.sql'))
    deadline = time.monotonic() + DEADLINE_SECONDS
    rules = json.loads(Path('src-tauri/league-rules.json').read_text(encoding='utf-8'))
    first_period = reward_period(rules, int(time.time()))
    result = {'platform': 'linux-x86_64', 'schema': expected_schema, 'success': False}
    report = Path(os.environ.get('SMOKE_REPORT', str(runner_temp / 'linux-install-smoke.json')))
    with tempfile.TemporaryDirectory(prefix='eternal-league-linux-smoke-', dir=runner_temp) as temporary:
        root = Path(temporary).resolve()
        install = root / 'install'
        install.mkdir()
        app = install / 'EternalLeague.AppImage'
        shutil.copy2(source, app)
        app.chmod(0o700)
        env = os.environ.copy()
        for secret in ['GH_TOKEN', 'GITHUB_TOKEN', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'NODE_AUTH_TOKEN']:
            env.pop(secret, None)
        for key, folder in [('HOME', 'home'), ('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'), ('XDG_CACHE_HOME', 'cache'), ('XDG_RUNTIME_DIR', 'runtime'), ('TMPDIR', 'tmp')]:
            directory = root / folder
            directory.mkdir(mode=0o700)
            env[key] = str(directory)
        env.update(APPIMAGE_EXTRACT_AND_RUN='1', WEBKIT_DISABLE_DMABUF_RENDERER='1', LIBGL_ALWAYS_SOFTWARE='1', GDK_BACKEND='x11')
        env.pop('ETERNAL_LEAGUE_PREVIEW_WEEKS', None)
        logs = []
        current = None
        log_handle = None
        database = None
        reward_snapshot = None
        marker = Path(env['XDG_CACHE_HOME']) / IDENTIFIER / 'phase5-persistence-probe.txt'
        probe_value = hashlib.sha256(str(root).encode()).hexdigest()

        def remaining():
            value = deadline - time.monotonic()
            if value <= 0:
                raise TimeoutError('The Linux install smoke test exceeded its 60-second budget.')
            return value

        def stop():
            nonlocal current, log_handle
            if current is not None:
                # start_new_session gives this launch its own group, including
                # only the AppImage and its WebKit descendants; no global pkill.
                try:
                    os.killpg(current.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    current.wait(timeout=max(0.1, min(4, deadline - time.monotonic())))
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(current.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    current.wait(timeout=2)
                current = None
            if log_handle:
                log_handle.close()
                log_handle = None

        def connection():
            return sqlite3.connect(f'file:{quote(str(database))}?mode=ro', uri=True, timeout=1)

        def assert_fresh_rewards():
            nonlocal reward_snapshot
            with connection() as db:
                db.execute('BEGIN')
                snapshot = validate_fresh_profile(db, rules, first_period, int(time.time()))
            if reward_snapshot is not None:
                if snapshot is None or snapshot['period'] < reward_snapshot['period']:
                    raise RuntimeError('Previously initialized first-use rewards disappeared.')
                if snapshot['period'] == reward_snapshot['period'] and snapshot != reward_snapshot:
                    raise RuntimeError('Earned rewards changed without another shared weekly boundary.')
            if snapshot is not None:
                reward_snapshot = snapshot

        def assert_probe():
            with connection() as db:
                row = db.execute('SELECT value FROM settings WHERE key=?', (PROBE,)).fetchone()
                if not row or row[0] != probe_value:
                    raise RuntimeError('The isolated settings probe did not survive relaunch/reinstall.')
            if not marker.is_file() or marker.read_text() != probe_value:
                raise RuntimeError('The isolated artwork-cache marker did not survive relaunch/reinstall.')

        def launch(label, seeded=False):
            nonlocal current, log_handle, database
            log = root / f'{label}.log'
            logs.append(log)
            log_handle = log.open('wb')
            current = subprocess.Popen([str(app)], cwd=install, env=env, stdout=log_handle, stderr=subprocess.STDOUT, start_new_session=True)
            stable_since = None
            while True:
                remaining()
                if current.poll() is not None:
                    raise RuntimeError(f'AppImage exited during {label} with status {current.returncode}.')
                candidates = [Path(env['XDG_CONFIG_HOME']) / IDENTIFIER / 'eternal-league.db', Path(env['XDG_DATA_HOME']) / IDENTIFIER / 'eternal-league.db']
                ready = False
                for candidate in candidates:
                    if not candidate.is_file():
                        continue
                    database = candidate
                    try:
                        with connection() as db:
                            rows = db.execute('SELECT version,success FROM _sqlx_migrations ORDER BY version').fetchall()
                            ready = len(rows) == expected_schema and rows[-1] == (expected_schema, 1) and all(success == 1 for _, success in rows)
                        if ready:
                            break
                    except sqlite3.Error:
                        pass
                if ready:
                    assert_fresh_rewards()
                    if seeded:
                        assert_probe()
                    stable_since = stable_since or time.monotonic()
                    if time.monotonic() - stable_since >= 1.5:
                        return
                else:
                    stable_since = None
                time.sleep(0.2)

        try:
            launch('first-install')
            stop()
            result['freshGameProgressEmpty'] = True
            with sqlite3.connect(database, timeout=2) as db:
                db.execute('INSERT INTO settings(key,value) VALUES(?,?)', (PROBE, probe_value))
            db.close()
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text(probe_value)
            launch('relaunch', seeded=True)
            stop()
            result['relaunchPreserved'] = True
            # AppImage installation is a standalone file: uninstall/reinstall
            # removes and replaces that file, never the XDG profile/cache.
            if app.parent.resolve() != install.resolve() or not app.is_file():
                raise RuntimeError('The owned installation path changed unexpectedly.')
            app.unlink()
            if not database.is_file() or not marker.is_file():
                raise RuntimeError('Removing the application file changed user data.')
            shutil.copy2(source, app)
            app.chmod(0o700)
            launch('reinstall', seeded=True)
            stop()
            result['reinstallPreserved'] = True
            result['initializedRewardsObserved'] = reward_snapshot is not None
            result['rewardValidation'] = 'Empty before verified first use, or exact canonical first-use and catch-up rewards.'
            result['creditedPeriod'] = reward_snapshot['period'] if reward_snapshot else None
            result['success'] = True
            print('PASS: Linux AppImage first launch, relaunch, and file reinstall preserved isolated settings/cache and validated canonical rewards with empty ownership/history.')
        except Exception as error:
            result['error'] = clean_error(error, root)
            for log in logs[-1:]:
                if log.is_file():
                    tail = log.read_text(errors='replace').splitlines()[-20:]
                    if tail:
                        print('AppImage failure log tail:\n' + clean_error('\n'.join(tail), root), file=sys.stderr)
            raise RuntimeError(result['error']) from None
        finally:
            stop()
            report.write_text(json.dumps(result, indent=2) + '\n')
    return result


def self_test():
    rules = json.loads(Path('src-tauri/league-rules.json').read_text(encoding='utf-8'))
    now = rules['startedAt'] + 4 * WEEK_SECONDS
    with sqlite3.connect(':memory:') as db:
        for name in ['001_initial.sql', '003_progression.sql', '005_expansion_rewards.sql', '007_pack_queue.sql']:
            db.executescript((Path('src-tauri/migrations') / name).read_text(encoding='utf-8-sig'))
        assert validate_fresh_profile(db, rules, 4, now) is None
        db.execute('INSERT INTO league_state VALUES(1,?,44,4)', (rules['startedAt'],))
        for rarity, amount in zip(RARITIES, [26, 13, 4, 2]):
            db.execute('UPDATE wildcards SET quantity=? WHERE rarity=?', (amount, rarity))
        ledger = {'version': 1, 'startingPacks': 20, 'weeklyPacks': 6,
                  'startingWildcards': dict(zip(RARITIES, [10, 5, 2, 1]))}
        db.execute('INSERT INTO settings VALUES(?,?)', (REWARD_LEDGER_KEY, json.dumps(ledger)))
        db.execute("INSERT INTO set_booster_balances VALUES('blb',8)")
        db.execute("INSERT INTO expansion_reward_claims VALUES('blb',4,8,'fixture')")
        db.executemany('INSERT INTO booster_pack_queue VALUES(?,?,?,?,?,?)', [
            ('starting', 'fdn', 'general', 0, 0, 20),
            ('weeklies-fdn', 'fdn', 'general', 1, 1, 18),
            ('weeklies-blb', 'blb', 'general', 4, 1, 6),
            ('bonus-blb', 'blb', 'bonus', 4, 0, 8),
        ])
        baseline = validate_fresh_profile(db, rules, 4, now)
        assert baseline['period'] == 4
        assert validate_fresh_profile(db, rules, 4, now) == baseline
        corruptions = [
            "UPDATE wildcards SET quantity=quantity+10 WHERE rarity='common'",
            'UPDATE league_state SET available_packs=45',
            'UPDATE league_state SET last_claimed_period=5',
            "UPDATE league_state SET started_at=1",
            "UPDATE booster_pack_queue SET set_code='woe' WHERE id='weeklies-blb'",
            "UPDATE booster_pack_queue SET remaining=9 WHERE id='bonus-blb'",
            "UPDATE booster_pack_queue SET priority=1 WHERE id='bonus-blb'",
            "DELETE FROM expansion_reward_claims",
            "UPDATE set_booster_balances SET quantity=16",
            "DELETE FROM settings WHERE key='league_reward_entitlements_v1'",
            "INSERT INTO booster_history(id,set_code,contents_json) VALUES('inherited','fdn','[]')",
        ]
        for sql in corruptions:
            db.execute('SAVEPOINT invalid_reward_fixture')
            db.execute(sql)
            try:
                validate_fresh_profile(db, rules, 4, now)
            except RuntimeError:
                pass
            else:
                raise AssertionError('Invalid first-use reward fixture was accepted.')
            finally:
                db.execute('ROLLBACK TO invalid_reward_fixture')
                db.execute('RELEASE invalid_reward_fixture')
        assert validate_fresh_profile(db, rules, 4, now) == baseline
    print('PASS: gate-waiting profile, week-four first-use rewards, repeat preservation, and 11 invalid reward/progress fixtures.')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('Usage: python3 scripts/linux-install-smoke.py path/to/app.AppImage | self-test')
        if sys.argv[1] == 'self-test':
            self_test()
        else:
            run(Path(sys.argv[1]))
    except Exception as error:
        print('Linux AppImage smoke failed: ' + clean_error(error), file=sys.stderr)
        sys.exit(1)
