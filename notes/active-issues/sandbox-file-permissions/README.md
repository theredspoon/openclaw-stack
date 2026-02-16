# Sandbox Sysbox UUID Issues

These notes are related to issues encountered while trying to deploy the host-alerter.

A quirk with how openclaw + docker + sysbox was discovered due to tmp file permissions
and timing issues with jiti compiling the telegram packages.

This issue was not previously exposed because of the timing of file creation in the tmp
dir used by jiti.

A solution was implemented in commit 37c15f33eed9f9980567e7cd19e93b32fa4f23bc:
Fix jiti cache permissions under Sysbox (Telegram plugin)
