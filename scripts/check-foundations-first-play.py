"""Attempt every FDN name in Play, using combat or stack positions when needed."""

import argparse
import csv
import os
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / "src-tauri/resources/game"
UNITS = ("ForgeImports", "ForgeGame", "ForgeMatch", "ForgeReplay", "ForgeCombat",
         "ForgeLibrary", "ForgeHistory", "ForgeManual")


def isolated_environment(scratch):
    env = dict(os.environ)
    for key in ("JDK_JAVA_OPTIONS", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS"):
        env.pop(key, None)
    for key in ("APPDATA", "LOCALAPPDATA", "HOME", "USERPROFILE", "TEMP", "TMP",
                "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
        env[key] = str(scratch)
    return env


def run_batch(install, jar, classes, start, batch):
    scratch = classes / str(start)
    scratch.mkdir()
    env = isolated_environment(scratch)
    source = scratch / "names.txt"
    rows = scratch / "results.tsv"
    reports = []
    while len(reports) < len(batch):
        remaining = batch[len(reports):]
        source.write_text("\n".join(remaining), encoding="utf-8")
        child = subprocess.run([
            "java", "-Xmx768m", "-Djava.awt.headless=true", "-Dfile.encoding=UTF-8",
            f"-Duser.home={scratch}", f"-Djava.io.tmpdir={scratch}",
            "-cp", os.pathsep.join([str(classes), str(jar)]), "FoundationsFirstPlay",
            str(install), str(scratch), str(source), str(rows),
        ], cwd=scratch, env=env, timeout=360)
        with rows.open(encoding="utf-8", newline="") as file:
            observed = list(csv.reader(file, delimiter="\t", quoting=csv.QUOTE_NONE))
        if not (child.returncode == 75 and observed and observed[-1][1] == "fixture timeout"):
            child.check_returncode()
        if not observed or [row[0] for row in observed] != remaining[:len(observed)]:
            raise RuntimeError("Incomplete or out-of-order results from Forge")
        reports.extend(observed)
    return reports


def run(install, names, output, workers, check):
    jar = install / "forge-gui-desktop-2.0.13-jar-with-dependencies.jar"
    with tempfile.TemporaryDirectory(prefix="foundations-first-play-") as folder:
        scratch = Path(folder).resolve()
        source = scratch / "FoundationsFirstPlay.java"
        units = [ADAPTER / f"{name}.java" for name in UNITS]
        units.append(ROOT / "src-tauri/test-fixtures/FoundationsFirstPlay.java")
        source.write_text("\n".join(unit.read_text(encoding="utf-8") for unit in units), encoding="utf-8")
        subprocess.run(["javac", "-encoding", "UTF-8", "-cp", str(jar), str(source)],
                       cwd=scratch, env=isolated_environment(scratch), check=True)
        outcomes = []
        # Limit per-process caches and isolate concurrent Forge instances from each other.
        with ThreadPoolExecutor(max_workers=workers) as pool:
            jobs = [pool.submit(run_batch, install, jar, scratch, start, names[start:start + 40])
                    for start in range(0, len(names), 40)]
            for job in jobs:
                outcomes.extend(job.result())
                print(f"Checked {len(outcomes)}/{len(names)}", flush=True)
        if [row[0] for row in outcomes] != names:
            raise RuntimeError("Forge results do not match the input card list")
    header = ["card", "first_play", "detail"]
    if check:
        with output.open(encoding="utf-8", newline="") as file:
            reader = csv.reader(file, delimiter="\t")
            if next(reader) != header:
                raise SystemExit(f"Unexpected header in {output}")
            expected = {row[0]: row for row in reader}
        actual = {row[0]: row for row in outcomes}
        changed = [name for name in sorted(expected.keys() | actual.keys()) if expected.get(name) != actual.get(name)]
        if changed:
            raise SystemExit(f"First-play results changed for {', '.join(changed)}")
    else:
        with output.open("w", encoding="utf-8", newline="") as file:
            writer = csv.writer(file, delimiter="\t", lineterminator="\n")
            writer.writerow(header)
            writer.writerows(outcomes)
    print(dict(Counter(row[1] for row in outcomes)))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("forge_install", type=Path)
    parser.add_argument("--ledger", type=Path, default=ROOT / "docs/foundations-card-audit.tsv")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/foundations-first-play.tsv")
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=2)
    parser.add_argument("--check", action="store_true", help="compare the run to the saved first-play report")
    args = parser.parse_args()
    with args.ledger.open(encoding="utf-8-sig", newline="") as file:
        reader = csv.DictReader(file, delimiter="\t")
        key = next(name for name in reader.fieldnames if name.lower() in ("card", "name", "card name", "card_name"))
        names = sorted(row[key] for row in reader)
    if not names or len(names) != len(set(names)):
        raise ValueError("Expected one row per distinct card")
    run(args.forge_install.resolve(), names, args.output.resolve(), args.workers, args.check)
