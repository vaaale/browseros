# Single entry point for supervised development.
#
# The Supervisor OWNS the base dev server: with BOS_BASE_DEV=1 it spawns `next dev`
# for base itself (no separate run-dev.sh needed), so it can npm-install + restart
# base automatically on promote while keeping HMR during development.
#
#   public (proxy)  -> :8090   (open BOS here)
#   base dev        -> :3000
#   preview pool    -> :3001+
BOS_DEV_ORIGINS=wingman.akhbar.lan BOS_BASE_DEV=1 BOS_PORT_BASE=3000 BOS_PUBLIC_PORT=8090 npm run supervisor
