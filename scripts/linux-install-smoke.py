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

        def assert_progress_empty():
            with connection() as db:
                for table in ['collection', 'decks', 'deck_cards', 'booster_history', 'progression_operations', 'league_state', 'booster_pack_queue']:
                    if db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] != 0:
                        raise RuntimeError(f'Fresh production profile contains unexpected {table} progress.')
                if db.execute('SELECT COALESCE(SUM(quantity),0) FROM wildcards').fetchone()[0] != 0:
                    raise RuntimeError('Fresh production profile contains unexpected wildcards.')

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
                    assert_progress_empty()
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
            result['freshProfileEmpty'] = True
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
            result['success'] = True
            print('PASS: Linux AppImage first launch, relaunch, and file reinstall preserved isolated settings/cache; game progress remained empty.')
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


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('Usage: python3 scripts/linux-install-smoke.py path/to/app.AppImage')
        run(Path(sys.argv[1]))
    except Exception as error:
        print('Linux AppImage smoke failed: ' + clean_error(error), file=sys.stderr)
        sys.exit(1)
