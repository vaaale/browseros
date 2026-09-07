#!/usr/bin/env bash
# LEGACY / standalone dev server (NO supervisor): plain `next dev`, no preview or
# promote. For supervised development use run-dev-supervisor.sh instead — the
# Supervisor now owns and starts the base dev server itself (single process), so
# you no longer run this alongside it.
#
# Override BOS_DEV_ORIGINS in .env instead of editing this file — see
# run-dev-supervisor.sh's comment for why.
set -a
[ -f .env ] && source .env
set +a

: "${BOS_DEV_ORIGINS:=wingman.akhbar.lan}"
export BOS_DEV_ORIGINS

npm run dev
