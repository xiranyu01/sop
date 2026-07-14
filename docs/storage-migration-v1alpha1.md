# Superseded storage migration runbook

The namespace/epoch cutover described by the earlier Proto-first experiment was
never used in production and is not part of the current runtime. This repository
now uses a fresh resource-scoped D1 schema, explicit one-time fixture bootstrap,
and no online old-format migration, dual write, or whole-site snapshot.

Use [Deployment, bootstrap, and recovery](operations/deployment-and-recovery.md)
for the supported initialization and D1 Time Travel procedures.
