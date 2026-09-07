#!/usr/bin/env bash
# Single entry point for supervised development.
#
# The Supervisor OWNS the base dev server: with BOS_BASE_DEV=1 it spawns `next dev`
# for base itself (no separate run-dev.sh needed), so it can npm-install + restart
# base automatically on promote while keeping HMR during development.
#
#   public (proxy)  -> :8090   (open BOS here)
#   base dev        -> :3000
#   preview pool    -> :3001+
#
# Override any of the vars below by setting them in .env instead of editing this
# file — a hand-edited tracked script dirties the live checkout, which trips the
# Supervisor's own safety gate (it expects the live checkout to stay clean and on
# its base branch) and gets reset on the next startup.
set -a
[ -f .env ] && source .env
set +a

: "${BOS_DEV_ORIGINS:=localhost}"
: "${BOS_BASE_DEV:=1}"
: "${BOS_PORT_BASE:=3000}"
: "${BOS_PUBLIC_PORT:=8090}"
export BOS_DEV_ORIGINS BOS_BASE_DEV BOS_PORT_BASE BOS_PUBLIC_PORT

npm run supervisor
