#!/usr/bin/env bash
set -euo pipefail

base=/opt/arcane-fold
repo="$base/source.git"
current="$base/current"
app_env=/etc/arcane-fold/app.env
app_user=arcane-fold
service=arcane-fold.service
github=https://github.com/yAnn1ck-B/arcane-fold.git
ci_url='https://api.github.com/repos/yAnn1ck-B/arcane-fold/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1'
requested="${1:-}"

if [[ $# -gt 1 || ( -n "$requested" && ! "$requested" =~ ^[0-9a-f]{40}$ ) ]]; then
    echo 'Pass a full, successfully tested main commit SHA or omit it to poll GitHub.' >&2
    exit 2
fi

mkdir -p "$base/releases"
exec 9>"$base/deploy.lock"
flock -n 9 || { echo 'Another Arcane Fold deployment is running.'; exit 0; }
if [[ ! -r "$app_env" ]]; then
    echo "Arcane Fold configuration is missing at $app_env." >&2
    exit 1
fi

candidate="$(curl --fail --silent --show-error --retry 2 --max-time 30 \
    --header 'Accept: application/vnd.github+json' "$ci_url" |
    jq -er '.workflow_runs[0] | select(.head_branch == "main" and .event == "push" and .conclusion == "success") | .head_sha')"
if [[ ! "$candidate" =~ ^[0-9a-f]{40}$ || ( -n "$requested" && "$candidate" != "$requested" ) ]]; then
    echo 'The requested release is not the latest successful main push in Web CI.' >&2
    exit 1
fi

previous="$(readlink -f "$current" || true)"
if [[ "$previous" == "$base/releases/$candidate" ]] && systemctl is-active --quiet "$service"; then
    exit 0
fi
if [[ -z "$requested" && -f "$base/failed-release" && "$(<"$base/failed-release")" == "$candidate" ]]; then
    exit 0
fi

if [[ ! -d "$repo" ]]; then
    git init --bare --quiet "$repo"
fi
git --git-dir="$repo" fetch --quiet --no-tags "$github" 'refs/heads/main:refs/remotes/origin/main'
if ! git --git-dir="$repo" merge-base --is-ancestor "$candidate" refs/remotes/origin/main; then
    echo "The successful run's commit is not on main." >&2
    exit 1
fi
if [[ -n "$previous" && -z "$requested" ]] &&
    ! git --git-dir="$repo" merge-base --is-ancestor "${previous##*/}" "$candidate"; then
    echo 'The candidate is older than the running release.'
    exit 0
fi

export PATH=/usr/local/bin:/usr/bin:/bin
scratch="$(mktemp -d "$base/.deploy.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
chmod 0755 "$scratch"
forge="$base/forge/2.0.13"
release="$base/releases/$candidate"

as_app() {
    runuser -u "$app_user" -- "$@"
}

db_check() {
    as_app node --env-file="$app_env" --input-type=module -e '
        import { pool } from "./web/db.mjs";
        try { process.stdout.write(String((await pool.query(process.argv[1])).rows[0]?.ready)); }
        finally { await pool.end(); }
    ' "$1"
}

if [[ ! -d "$release" ]]; then
    work="$scratch/source"
    mkdir "$work"
    git --git-dir="$repo" archive "$candidate" | tar --extract --directory "$work"
    bash "$work/deploy/azure/install-forge.sh" "$forge"
    printf 'FORGE_INSTALL=%s\n' "$forge" > "$work/forge.env"
    chown -R "$app_user:$app_user" "$work"
    install -d -o "$app_user" -g "$app_user" -m 0700 "$scratch/npm-cache"
    (
        cd "$work"
        as_app env npm_config_cache="$scratch/npm-cache" npm ci --include=dev --no-audit --no-fund
        as_app npm run build
        as_app env npm_config_cache="$scratch/npm-cache" npm prune --omit=dev --ignore-scripts --no-audit --no-fund
    )
    printf '%s\n' "$candidate" > "$work/dist-web/__arcane-release.txt"
    chown -R root:root "$work"
    chmod -R a+rX,go-w "$work"
    mv --no-target-directory "$work" "$release"
fi

defer_during_play() {
    if [[ -z "$previous" || -n "$requested" ]]; then return; fi
    local active
    active="$(db_check "
        SELECT EXISTS (SELECT 1 FROM web_rooms WHERE status='playing'
          AND archived_at IS NULL AND paused_at IS NULL
          AND updated_at > now() - interval '15 minutes') AS ready
    ")"
    if [[ "$active" == true ]]; then
        echo 'A match was active in the last 15 minutes. The release is staged for the next check.'
        exit 0
    fi
}

cd "$release"
defer_during_play
as_app node --env-file="$app_env" --env-file="$release/forge.env" web/setup-db.mjs
catalog_key="$(sha256sum web/catalog.mjs web/league-rules.json deploy/azure/install-forge.sh | sha256sum | cut -d ' ' -f 1)"
catalog_ready="$(db_check 'SELECT EXISTS (SELECT 1 FROM web_cards) AS ready')"
if [[ "$catalog_ready" != true || ! -f "$base/catalog-key" || "$(<"$base/catalog-key")" != "$catalog_key" ]]; then
    catalog_args=()
    catalog_file=/var/lib/arcane-fold/app/catalog.jsonl
    if [[ -s "$catalog_file" ]]; then
        catalog_args+=(--jsonl "$catalog_file")
    fi
    as_app node --env-file="$app_env" --env-file="$release/forge.env" web/catalog.mjs "${catalog_args[@]}"
    printf '%s\n' "$catalog_key" > "$scratch/catalog-key"
    mv --no-target-directory "$scratch/catalog-key" "$base/catalog-key"
fi

public_origin="$(as_app node --env-file="$app_env" -p 'new URL(process.env.WEB_ORIGIN).origin')"
public_host="${public_origin#https://}"
port="$(as_app node --env-file="$app_env" -p "process.env.WEB_PORT || '4317'")"
web="http://127.0.0.1:$port"
defer_during_play

activate() {
    ln -s -- "$1" "$scratch/current" &&
    mv --no-target-directory "$scratch/current" "$current" &&
    systemctl restart "$service"
}

healthy() {
    local expected="$1"
    for ((attempt=0; attempt<45; attempt++)); do
        if [[ "$(curl --fail --silent --max-time 2 -H "Host: $public_host" "$web/__arcane-release.txt")" == "$expected" ]] &&
            curl --fail --silent --max-time 2 -H "Host: $public_host" "$web/api/auth" |
            jq --exit-status '.user == null and .localPlay == false' >/dev/null; then
            return 0
        fi
        sleep 2
    done
    return 1
}

if activate "$release" && healthy "$candidate"; then
    rm -f -- "$base/failed-release"
    echo "Arcane Fold is running $candidate."
else
    printf '%s\n' "$candidate" > "$base/failed-release"
    echo "Arcane Fold release $candidate did not become ready." >&2
    if [[ -n "$previous" && "$previous" != "$release" && -d "$previous" ]]; then
        activate "$previous"
        healthy "${previous##*/}"
        echo "Restored Arcane Fold release ${previous##*/}." >&2
    else
        systemctl stop "$service"
        rm -f -- "$current"
    fi
    exit 1
fi
