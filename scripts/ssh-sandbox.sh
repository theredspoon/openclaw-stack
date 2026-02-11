#!/usr/bin/env bash
# Runs a new interactive sandbox container inside the gateway's nested Docker.
# The container is automatically removed on exit (--rm).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../openclaw-config.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Error: openclaw-config.env not found at $CONFIG_FILE" >&2
  exit 1
fi

source "$CONFIG_FILE"

IMAGE="openclaw-sandbox-common:bookworm-slim"

printf '\033[32mStarting sandbox container (%s) \033[0m\n' "$IMAGE"
ssh -t -i "${SSH_KEY_PATH}" -p "${SSH_PORT}" "${SSH_USER}@${VPS1_IP}" \
  "sudo docker exec -it openclaw-gateway docker run --rm -it \
    --user 1000:1000 \
    --network bridge \
    --memory 2g \
    --cpus 2 \
    --tmpfs /tmp --tmpfs /var/tmp --tmpfs /run \
    --tmpfs /home/linuxbrew:uid=1000,gid=1000 \
    -v /opt/skill-bins:/opt/skill-bins:ro \
    -e LANG=C.UTF-8 \
    -e PATH=/opt/skill-bins:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    -w /workspace \
    $IMAGE bash"
