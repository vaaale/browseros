# LEGACY / standalone dev server (NO supervisor): plain `next dev`, no preview or
# promote. For supervised development use run-dev-supervisor.sh instead — the
# Supervisor now owns and starts the base dev server itself (single process), so
# you no longer run this alongside it.
BOS_DEV_ORIGINS=wingman.akhbar.lan npm run dev
