# Closure fixture

The closure gate uses this stable workspace for Codex and Kimi Code so their
workspace-trust stores do not accumulate a new, immediately orphaned path on
every run. Claude Code reviews the repository root, where the user explicitly
authorized branch access. Runtime handoff files are removed after the gate.
