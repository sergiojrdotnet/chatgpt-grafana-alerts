#!/usr/bin/env bash
set -euo pipefail

release_tag=${1:?Usage: release.sh vX.Y.Z ghcr.io/owner/image@sha256:digest}
image_digest=${2:?An immutable image digest is required}
[[ "$release_tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid release tag' >&2; exit 1; }
[[ "$image_digest" =~ ^ghcr\.io/sergiojrdotnet/chatgpt-grafana-alerts@sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid image digest' >&2; exit 1; }
release_root=$(git rev-parse --show-toplevel)
[[ $(git -C "$release_root" describe --tags --exact-match HEAD) == "$release_tag" ]] || { echo 'Checkout does not match the release tag' >&2; exit 1; }
[[ -z $(git -C "$release_root" status --porcelain --untracked-files=no) ]] || { echo 'Release checkout has modified tracked files' >&2; exit 1; }
expected_revision=$(git -C "$release_root" rev-parse HEAD)
docker network inspect aluno-expert-net >/dev/null
test -s /etc/chatgpt-grafana-alerts/server.env
export IMAGE_DIGEST="$image_digest"
export SERVER_ENV_FILE=/etc/chatgpt-grafana-alerts/server.env
compose=(docker compose --project-directory "$release_root" -f "$release_root/deploy/compose.yaml")
previous_image=$(docker inspect chatgpt-grafana-alerts-grafana-alerts-1 --format '{{.Config.Image}}' 2>/dev/null || true)
"${compose[@]}" pull
actual_revision=$(docker image inspect "$image_digest" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[[ "$actual_revision" == "$expected_revision" ]] || { echo 'Image revision does not match the release checkout' >&2; exit 1; }
if ! "${compose[@]}" up -d --wait --wait-timeout 120; then
  if [[ -n "$previous_image" ]]; then
    echo 'Startup failed; restoring the previous image' >&2
    IMAGE_DIGEST="$previous_image" "${compose[@]}" up -d --wait --wait-timeout 120
  else
    echo 'Initial startup failed; stopping the new project and preserving its volumes' >&2
    "${compose[@]}" stop
  fi
  exit 1
fi
"${compose[@]}" ps
umask 077
printf '{"tag":"%s","revision":"%s","image":"%s","deployedAt":"%s"}\n' "$release_tag" "$expected_revision" "$image_digest" "$(date -u +%FT%TZ)" > /etc/chatgpt-grafana-alerts/release.json.tmp
mv /etc/chatgpt-grafana-alerts/release.json.tmp /etc/chatgpt-grafana-alerts/release.json
printf 'Released %s at %s from %s\n' "$release_tag" "$(date -u +%FT%TZ)" "$expected_revision"
