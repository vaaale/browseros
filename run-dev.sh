# BOS_SUPERVISOR_URL makes the dev server supervisor-aware: the assistant's
# self-modifications are provisioned as isolated candidate worktrees (preview +
# promote) instead of editing this live working tree in-place. Must match the
# supervisor's public port in run-dev-supervisor.sh (:8090).
BOS_DEV_ORIGINS=wingman.akhbar.lan BOS_SUPERVISOR_URL=http://127.0.0.1:8090 npm run dev
