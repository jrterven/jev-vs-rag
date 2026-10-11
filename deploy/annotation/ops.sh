#!/bin/sh
set -eu
umask 077
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMMAND=${1:-help}
if [ "$#" -gt 0 ]; then shift; fi
fail() { printf '%s\n' "Error: $*" >&2; exit 1; }
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@";
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$@";
  else fail 'Install sha256sum or shasum.'; fi
}
verify() { (cd "$HERE" && checksum -c SHA256SUMS); }
load_config() {
  CONFIG=${ANNOTATION_DEPLOY_ENV:-$HERE/deploy.env}
  [ -f "$CONFIG" ] || fail "Create $CONFIG from deploy.env.example."
  ANNOTATION_PROJECT=jev-annotation
  ANNOTATION_IMAGE=
  ANNOTATION_ORIGIN=
  ANNOTATION_BIND_PORT=13002
  ANNOTATION_DATA_VOLUME=jev-annotation-data
  ANNOTATION_PROXY_NETWORK=
  ANNOTATION_PROXY_ALIAS=jev-annotation-upstream
  SEEN=' '
  # Parse an intentionally small format. Never source an operator-supplied file.
  while IFS= read -r LINE || [ -n "$LINE" ]; do
    case "$LINE" in ''|'#'*) continue;; esac
    case "$LINE" in *=*) KEY=${LINE%%=*}; VALUE=${LINE#*=};; *) fail 'Expected KEY=value in deployment config.';; esac
    case "$SEEN" in *" $KEY "*) fail "Duplicate configuration key: $KEY";; esac
    SEEN="$SEEN$KEY "
    case "$KEY" in
      ANNOTATION_PROJECT|ANNOTATION_IMAGE|ANNOTATION_ORIGIN|ANNOTATION_BIND_PORT|ANNOTATION_DATA_VOLUME|ANNOTATION_PROXY_NETWORK|ANNOTATION_PROXY_ALIAS) export "$KEY=$VALUE";;
      *) fail "Unknown deployment key: $KEY";;
    esac
  done < "$CONFIG"
  for IDENTIFIER in "$ANNOTATION_PROJECT" "$ANNOTATION_DATA_VOLUME" "$ANNOTATION_PROXY_ALIAS"; do
    printf '%s\n' "$IDENTIFIER" | LC_ALL=C awk '/^[a-z0-9][a-z0-9_-]*$/ {ok=1} END {exit !ok}' || fail 'Project, volume and proxy alias must use lowercase letters, numbers, _ or -.'
  done
  case "$ANNOTATION_PROXY_NETWORK" in *[!a-zA-Z0-9_.-]*) fail 'Invalid proxy network name.';; esac
  printf '%s\n' "$ANNOTATION_IMAGE" | LC_ALL=C awk '/^[a-z0-9][a-z0-9_.\/:@-]*$/ {ok=1} END {exit !ok}' || fail 'Set a valid image name and immutable release tag.'
  case "$ANNOTATION_IMAGE" in *:latest|*:release-YYYYMMDD-1) fail 'Choose a unique release image tag.';; *:*|*@sha256:*) :;; *) fail 'Use a versioned image tag.';; esac
  printf '%s\n' "$ANNOTATION_BIND_PORT" | LC_ALL=C awk '/^[0-9]+$/ && $0>=1024 && $0<=65535 {ok=1} END {exit !ok}' || fail 'Bind port must be 1024–65535.'
  printf '%s\n' "$ANNOTATION_ORIGIN" | LC_ALL=C awk '/^https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]+)?$/ {ok=1} END {exit !ok}' || fail 'Origin must be an exact HTTPS origin without a trailing slash.'
  PUBLIC_HOST=${ANNOTATION_ORIGIN#https://}
  export ANNOTATION_PROJECT ANNOTATION_IMAGE ANNOTATION_ORIGIN ANNOTATION_BIND_PORT ANNOTATION_DATA_VOLUME ANNOTATION_PROXY_NETWORK ANNOTATION_PROXY_ALIAS
}
compose() {
  if [ -n "$ANNOTATION_PROXY_NETWORK" ]; then
    docker compose --project-name "$ANNOTATION_PROJECT" --env-file "$CONFIG" -f "$HERE/compose.yaml" -f "$HERE/compose.proxy-network.yaml" "$@"
  else
    docker compose --project-name "$ANNOTATION_PROJECT" --env-file "$CONFIG" -f "$HERE/compose.yaml" "$@"
  fi
}
require_engine() {
  VERSION=$(docker version --format '{{.Server.Version}}')
  MAJOR=${VERSION%%.*}
  case "$MAJOR" in ''|*[!0-9]*) fail 'Unable to identify Docker Engine version.';; esac
  [ "$MAJOR" -ge 28 ] || fail 'Use Docker Engine 28+; older releases may expose loopback-published ports to the local network.'
  docker compose version >/dev/null
}
health() {
  curl --fail --silent --show-error --max-time 10 -H "Host: $PUBLIC_HOST" "http://127.0.0.1:$ANNOTATION_BIND_PORT/api/annotation/health"
  printf '\n'
}
proxy() {
  UPSTREAM="127.0.0.1:$ANNOTATION_BIND_PORT"
  if [ -n "$ANNOTATION_PROXY_NETWORK" ]; then UPSTREAM="$ANNOTATION_PROXY_ALIAS:3002"; fi
  case "${1:-}" in
    caddy)
      cat <<EOF
$PUBLIC_HOST {
    encode zstd gzip
    reverse_proxy $UPSTREAM {
        header_up Host $PUBLIC_HOST
        header_up X-Forwarded-For {http.request.remote.host}
        header_up X-Forwarded-Proto https
    }
}
EOF
      ;;
    nginx)
      cat <<EOF
# Insert ONLY into the existing HTTPS server block for $PUBLIC_HOST.
# Its TLS certificates and renewal stay managed by the existing proxy.
location / {
    client_max_body_size 128m;
    proxy_pass http://$UPSTREAM;
    proxy_set_header Host $PUBLIC_HOST;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_connect_timeout 10s;
    proxy_read_timeout 180s;
}
EOF
      ;;
    *) fail 'Usage: ops.sh proxy caddy|nginx';;
  esac
}

case "$COMMAND" in
  help|--help|-h)
    cat <<'EOF'
Annotation release operations (only this Compose project/service):
  verify                       Check release SHA-256 manifest
  config                       Validate/render isolated Compose configuration
  build                        Build the configured image; no service changes
  up                           Start/update only annotation using the built image
  status | logs | stop          Operate only annotation
  health | public-health       Check local app or public HTTPS endpoint
  proxy caddy|nginx             Print a fragment for the existing proxy
  admin bootstrap NAME         Create first coordinator (prints private invite)
  admin participants           List accounts
  admin invite ID              Issue replacement invitation
  backup NEW_FILE.sqlite       Consistent live SQLite snapshot plus checksum
  restore FILE.sqlite NEW_VOL  Restore into a new volume; never switches live app
Set ANNOTATION_DEPLOY_ENV to use another plain-text deployment configuration.
EOF
    exit 0;;
  verify) verify; exit 0;;
esac
load_config
case "$COMMAND" in
  config) compose config;;
  build) verify; require_engine; compose build --pull annotation;;
  up) verify; require_engine; compose up -d --no-deps --no-build --wait --wait-timeout 120 annotation; health;;
  status) compose ps annotation;;
  logs) compose logs --tail 100 annotation;;
  stop) compose stop annotation;;
  health) health;;
  public-health) curl --fail --silent --show-error --max-time 15 "$ANNOTATION_ORIGIN/api/annotation/health"; printf '\n';;
  proxy) proxy "$@";;
  admin)
    case "${1:-}" in bootstrap|participants|invite) :;; *) fail 'Allowed admin commands: bootstrap, participants, invite.';; esac
    compose exec -T annotation node annotation/dist/runtime/server/cli.js "$@";;
  backup)
    [ "$#" -eq 1 ] || fail 'Usage: ops.sh backup NEW_FILE.sqlite'
    TARGET=$1
    [ ! -e "$TARGET" ] || fail 'Backup destination already exists.'
    mkdir -p "$(dirname -- "$TARGET")"
    TARGET_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$TARGET")" && pwd)
    TARGET="$TARGET_DIRECTORY/$(basename -- "$TARGET")"
    TEMP=$(mktemp "$TARGET_DIRECTORY/.annotation-backup.XXXXXXXX")
    trap 'rm -f "$TEMP"' EXIT HUP INT TERM
    BACKUP_NAME="operator-$(date -u +%Y%m%dT%H%M%SZ)-$$.sqlite"
    CONTAINER_PATH="/data/backups/$BACKUP_NAME"
    compose exec -T annotation node annotation/dist/runtime/server/cli.js backup "$CONTAINER_PATH"
    compose cp "annotation:$CONTAINER_PATH" "$TEMP"
    chmod 600 "$TEMP"
    ln "$TEMP" "$TARGET" || fail 'Could not install backup without overwriting an existing file.'
    rm -f "$TEMP"
    (cd "$TARGET_DIRECTORY" && checksum "$(basename -- "$TARGET")") > "$TARGET.sha256"
    compose exec -T annotation node -e 'require("node:fs").unlinkSync(process.argv[1])' "$CONTAINER_PATH"
    printf '%s\n' "Backup: $TARGET";;
  restore)
    [ "$#" -eq 2 ] || fail 'Usage: ops.sh restore FILE.sqlite NEW_VOLUME'
    SOURCE=$1; NEW_VOLUME=$2
    [ -f "$SOURCE" ] || fail 'Backup file does not exist.'
    printf '%s\n' "$NEW_VOLUME" | LC_ALL=C awk '/^[a-z0-9][a-z0-9_-]*$/ {ok=1} END {exit !ok}' || fail 'Invalid new volume name.'
    case "$NEW_VOLUME" in "$ANNOTATION_PROJECT"-*) :;; *) fail 'New volume must start with the annotation project name and a hyphen.';; esac
    [ "$NEW_VOLUME" != "$ANNOTATION_DATA_VOLUME" ] || fail 'Restoration cannot target the live volume.'
    docker image inspect "$ANNOTATION_IMAGE" >/dev/null
    if docker volume inspect "$NEW_VOLUME" >/dev/null 2>&1; then fail 'Restore requires a volume name that does not exist.'; fi
    if [ -f "$SOURCE.sha256" ]; then (cd "$(dirname -- "$SOURCE")" && checksum -c "$(basename -- "$SOURCE").sha256"); fi
    docker volume create --label "annotation.project=$ANNOTATION_PROJECT" --label annotation.purpose=restore "$NEW_VOLUME" >/dev/null
    docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
      --tmpfs /tmp:size=64m,mode=1777 --mount "type=volume,src=$NEW_VOLUME,dst=/data" \
      -e NODE_ENV=production -e ANNOTATION_DATA_DIR=/data -e "ANNOTATION_ORIGIN=$ANNOTATION_ORIGIN" \
      "$ANNOTATION_IMAGE" node ops/restore-stdin.mjs < "$SOURCE"
    printf '%s\n' "Restored into $NEW_VOLUME. The live service was not changed." \
      "To switch: set ANNOTATION_DATA_VOLUME=$NEW_VOLUME in $CONFIG, then run ./ops.sh up." \
      'Old sessions and invitations are invalid. Use admin participants and admin invite ID after switching.';;
  *) fail "Unknown command: $COMMAND";;
esac
