#!/usr/bin/env bash
# Override BOS_SUPERVISOR_URL in .env instead of editing this file — see
# run-dev-supervisor.sh's comment for why.
set -a
[ -f .env ] && source .env
set +a

: "${BOS_SUPERVISOR_URL:=http://127.0.0.1:8080}"
export BOS_SUPERVISOR_URL

npm run supervisor
