#!/usr/bin/env bash
# Usage: assert-deployed.sh <service> <image:tag> [timeout_s=180] [settle_s=10] [mark_file]
# mark_file: "<Version.Index>|<UpdateStatus.StartedAt>" (or "none") recorded before the deploy/update.
# If the index changed, only an UpdateStatus newer than the mark counts (stale states are ignored);
# if it did not change, nothing was updated and only image + health are checked.
# Swarm rollbacks exit 0, so verify the service really runs <image:tag> and its container is healthy.
set -uo pipefail
svc=$1 want=$2 timeout=${3:-180} settle=${4:-10} mark=${5:-}
base_idx="" base_started=""
if [ -n "$mark" ] && [ -f "$mark" ]; then
  IFS="|" read -r base_idx base_started < "$mark"
  [ "$base_idx" != none ] || { base_idx=""; base_started=""; }
fi

fail() {
  echo "::error::$*" >&2
  docker service ps "$svc" --no-trunc || true
  docker service logs --tail 50 "$svc" || true
  exit 1
}

end=$((SECONDS + timeout))
while [ "$SECONDS" -lt "$end" ]; do
  upd=$(docker service inspect "$svc" --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null)
  started=$(docker service inspect "$svc" --format '{{if .UpdateStatus}}{{.UpdateStatus.StartedAt}}{{end}}' 2>/dev/null)
  idx=$(docker service inspect "$svc" --format '{{.Version.Index}}' 2>/dev/null)
  if [ -n "$base_idx" ] && [ "$idx" != "$base_idx" ] && [ "$started" = "$base_started" ]; then
    # Service changed but UpdateStatus is still the pre-deploy one: not ours yet
    upd=stale
  elif [ -n "$base_idx" ] && [ "$idx" = "$base_idx" ]; then
    upd=""  # nothing was updated: only image + health matter
  fi
  spec=$(docker service inspect "$svc" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null)
  case "$upd" in stale) sleep 2; continue;; rollback_*|paused) fail "update ended in state '$upd' (rolled back or crash loop)";; esac
  if [ "${spec%%@*}" = "$want" ] && { [ -z "$upd" ] || [ "$upd" = completed ]; }; then
    cid=$(docker ps -q --filter "label=com.docker.swarm.service.name=$svc" --filter health=healthy | head -n1)
    if [ -n "$cid" ] && [ "$(docker inspect --format '{{.Config.Image}}' "$cid" | cut -d@ -f1)" = "$want" ]; then
      # Must stay up and healthy through the settle window (catches a crash right after start)
      sleep "$settle"
      if docker ps -q --filter "id=$cid" --filter health=healthy | grep -q .; then
        echo "$svc runs $want and is healthy"
        exit 0
      fi
    fi
  fi
  echo "waiting for $svc -> $want (update=${upd:-none}, spec=${spec%%@*})"
  sleep 5
done
fail "$svc did not run $want healthy within ${timeout}s"
