The Problem: jiti cache files in /tmp get root ownership under Sysbox

What jiti does

jiti is a TypeScript JIT compiler used by OpenClaw. When the gateway loads a TypeScript file (like the Telegram plugin
  at /app/extensions/telegram/index.ts), jiti compiles it to JavaScript and caches the result as .cjs files in a cache
directory. By default, that directory is /tmp/jiti/.

What Sysbox does

Sysbox is the container runtime we use for sandbox isolation. It provides rootless containers via uid remapping —
Linux user namespaces that remap container UIDs to unprivileged host UIDs. This is what lets us safely run
Docker-inside-Docker without giving the gateway container real root on the host.

The bug

Under Sysbox's uid remapping, files written to /tmp inside the container appear root-owned even when the writing
process is running as uid 1000 (node). This is a quirk of how Sysbox handles /tmp with overlay2 filesystems — the uid
mapping gets confused for this specific mount point.

So when the gateway process (running as node after gosu drops privileges) loads the Telegram plugin and jiti tries to
cache compiled files to /tmp/jiti/, those files end up with root:root ownership and 644 permissions (rw-r--r--). The
node process can read them but can't write to them. When jiti later tries to open one of those cache files for writing
  (to update or create alongside them), it gets:

EACCES: permission denied, open '/tmp/jiti/components-cancellable-loader.eaa62cac.cjs'

The Telegram plugin fails to load, and the gateway starts without Telegram support.

Why it was hard to diagnose

Several things made this confusing:

1. The coordinator plugin loads fine. It's a .js file (not TypeScript), so jiti does minimal work. The few jiti cache
files it creates apparently get written before the problematic ones accumulate.
2. All processes show the correct user. ps aux shows the gateway as node (PID 85) and the noVNC proxy as node (PID
842). There's no visible root process creating these files. The root ownership is a filesystem-level artifact of
Sysbox's uid remapping, not an actual root process.
3. The entrypoint is bind-mounted. I spent several iterations patching the Dockerfile with RUN commands to modify the
entrypoint script inside the image — but the docker-compose config bind-mounts scripts/entrypoint-gateway.sh from the
host into the container, overriding any in-image patches. Those Dockerfile changes were silently doing nothing.
4. Multiple red herrings. I initially suspected the noVNC proxy (which ran as root) was creating the files. Switching
it to run as node (gosu node node "$NOVNC_PROXY" &) was a good change but didn't fix the core issue. I also tried
clearing /tmp/jiti before dropping privileges, but the directory didn't exist yet at that point — the files only
appear after the gateway starts loading plugins.
5. docker compose restart preserves container state. /tmp persists across restarts (same container, same filesystem).
Stale root-owned files from previous runs survived restarts, which confused debugging. Only --force-recreate gives a
fresh /tmp.

What I tried (in order)

Attempt: 1
Approach: RUN rm -rf /tmp/jiti in Dockerfile after pnpm build
Why it failed: Cleared build-time cache, but runtime files still root-owned
────────────────────────────────────────
Attempt: 2
Approach: Patch entrypoint via Dockerfile RUN (head/tail to insert chown)
Why it failed: Entrypoint is bind-mounted — Dockerfile patches overridden
────────────────────────────────────────
Attempt: 3
Approach: Run noVNC proxy as node (gosu node)
Why it failed: Good hygiene, but node-owned files in /tmp still appear root-owned under Sysbox
────────────────────────────────────────
Attempt: 4
Approach: rm -rf /tmp/jiti in entrypoint before exec gosu node
Why it failed: Directory doesn't exist yet (files created after gateway starts)
────────────────────────────────────────
Attempt: 5
Approach: Set JITI_CACHE_DIR env var
Why it failed: This env var doesn't exist in jiti — I guessed wrong
────────────────────────────────────────
Attempt: 6
Approach: Set TMPDIR=/home/node/.cache/tmp
Why it failed: This worked

The Solution

What we do

In deploy/openclaw-stack/entrypoint.sh, section 2c, right before dropping privileges:

export TMPDIR="/home/node/.cache/tmp"
mkdir -p "$TMPDIR"
chown 1000:1000 "$TMPDIR"

Then exec gosu node "$@" inherits this environment.

Why it works

jiti determines its cache directory by calling os.tmpdir(), which reads the TMPDIR environment variable. By default
TMPDIR is unset, so os.tmpdir() returns /tmp. By setting TMPDIR to /home/node/.cache/tmp, jiti caches to
/home/node/.cache/tmp/jiti/ instead.

/home/node/ is under the node user's home directory, which doesn't exhibit the Sysbox uid remapping quirk that /tmp
does. Files written by the node process stay node-owned, and jiti can read and write freely.

Why we need it

Without this fix, the Telegram plugin (and potentially any future TypeScript-based plugin) can't load. The gateway
starts without Telegram support, which means:

- No Telegram bot for receiving messages
- No Telegram delivery for cron job alerts (the daily health check we just built)
- Any plugin shipped as .ts (rather than pre-compiled .js) would fail the same way

This is specifically a Sysbox + /tmp + jiti interaction. Non-Sysbox Docker setups wouldn't hit this because /tmp file
ownership would behave normally.

> Sent to a separate claude instance...
>
> ❯ do you see a better way to solve this for our project?

Good writeup. Looking at the full picture, I think your current solution is actually the right one — but let me
  explain why and flag one nuance.

  Why the current fix is solid

  The TMPDIR redirect is the correct level to fix this at. Here's what I considered:

  Can't fix it at the tmpfs layer. Your docker-compose already mounts /tmp as tmpfs:

  tmpfs:
    - /tmp:size=1G,mode=1777

  So the uid remapping issue isn't overlay2-specific as the writeup suggests — it's Sysbox's user namespace remapping
  affecting tmpfs mounts too. Adding uid=1000,gid=1000 to the tmpfs options wouldn't help because the issue is
  per-file ownership after creation, not mount-level ownership.

  Can't scope it to just jiti. jiti reads os.tmpdir() internally — no JITI_CACHE_DIR env var, no way to configure it
  without modifying OpenClaw source. Since the entrypoint runs exec gosu node "$@", the env var must apply to the
  whole process tree.

  Can't pre-create /tmp/jiti/. The directory would have correct ownership, but individual .cjs files created by the
  node process would still get root-owned under Sysbox's remapping.

  One side effect to be aware of

  Setting TMPDIR globally means all temp file operations (not just jiti) go to /home/node/.cache/tmp on overlay2
  instead of the 1GB RAM-backed tmpfs at /tmp. Two implications:

  1. Disk I/O instead of RAM for temp files — negligible for this workload (API gateway, not a file processing
  pipeline)
  2. No size cap — the tmpfs had a 1G limit as a safety net. On overlay2, temp files are bounded only by container
  disk. Unlikely to matter but worth knowing.

  If either of those ever became a concern, you could add a dedicated tmpfs mount for the redirect target in
  docker-compose:

  tmpfs:
    - /tmp:size=1G,mode=1777
    - /home/node/.cache/tmp:size=512M,mode=1777

  But I'd only do that if you actually see a problem — it introduces a question of whether Sysbox's remapping would
  affect that mount too.

  Verdict

  Keep what you have. It's minimal, well-commented, and fixes the root cause. The TMPDIR side effect is academic for
  this workload. The jiti cache persisting across restart (vs. being wiped on tmpfs) is actually a bonus — faster
  gateway restarts.
