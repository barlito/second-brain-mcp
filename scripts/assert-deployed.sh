#!/usr/bin/env bash
# Usage: assert-deployed.sh <service> <image:tag> [timeout_s=180] [settle_s=10] [mark_file]
# mark_file: "<Version.Index>|<UpdateStatus.StartedAt>" recorded before the deploy/update, or
# "none" when the service did not exist yet (Makefile mark_service; it aborts on inspect errors).
# If the index changed, only an UpdateStatus newer than the mark counts (stale states are ignored);
# if it did not change, nothing was updated and only image + health are checked.
# Swarm resets UpdateStatus on a spec change and only sets a new one when a running task must be
# replaced, so an update that touches no running task (service scaled to 0 then
# `--replicas 1 --image`, label-only redeploy) never gets one: the stale wait is bounded
# (stale_max_s) and then falls through to the image + health check.
# Swarm rollbacks exit 0, so verify the service really runs <image:tag> and its container is healthy.
set -uo pipefail
svc=$1 want=$2 timeout=${3:-180} settle=${4:-10} mark=${5:-}
stale_max=${STALE_MAX_S:-20}
base_idx="" base_started=""
if [ -n "$mark" ]; then
  if [ -s "$mark" ]; then
    IFS="|" read -r base_idx base_started < "$mark"
    if [ "$base_idx" = none ]; then
      base_idx="" base_started=""
    elif ! [[ "$base_idx" =~ ^[0-9]+$ ]]; then
      echo "::warning::unreadable mark '$base_idx' in $mark: stale update states cannot be filtered" >&2
      base_idx="" base_started=""
    fi
  else
    echo "::warning::mark file $mark missing or empty: stale update states cannot be filtered" >&2
  fi
fi

fail() {
  echo "::error::$*" >&2
  docker service ps "$svc" --no-trunc || true
  docker service logs --tail 50 "$svc" || true
  exit 1
}

fmt='{{.Version.Index}}|{{if .UpdateStatus}}{{.UpdateStatus.State}}|{{.UpdateStatus.StartedAt}}{{else}}|{{end}}|{{.Spec.TaskTemplate.ContainerSpec.Image}}'
end=$((SECONDS + timeout))
stale_since=""
while [ "$SECONDS" -lt "$end" ]; do
  # One inspect = one consistent snapshot
  if ! snap=$(docker service inspect "$svc" --format "$fmt" 2>/dev/null) || [ -z "$snap" ]; then
    echo "waiting for $svc -> $want (service inspect failed, retrying)"
    sleep 5
    continue
  fi
  IFS="|" read -r idx upd started spec <<< "$snap"
  if [ -n "$base_idx" ] && [ "$idx" != "$base_idx" ] && [ "$started" = "$base_started" ]; then
    # Service changed but UpdateStatus is still the pre-deploy one: not ours yet, or never coming
    # (no running task touched). Wait a bounded time, then judge on image + health only.
    [ -n "$stale_since" ] || stale_since=$SECONDS
    if [ $((SECONDS - stale_since)) -lt "$stale_max" ]; then
      sleep 2
      continue
    fi
    upd=""
  elif [ -n "$base_idx" ] && [ "$idx" = "$base_idx" ]; then
    upd=""  # nothing was updated: only image + health matter
  fi
  case "$upd" in rollback_*|paused) fail "update ended in state '$upd' (rolled back or crash loop)";; esac
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
