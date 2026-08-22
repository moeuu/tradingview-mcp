# Repository Instructions

## Codex review waiting

- When asked to wait for or monitor a Codex pull-request review after a push,
  use the globally installed `$wait-for-codex-review` skill.
- Keep Codex review polling and gate implementation out of this repository. Do
  not add repository-local review-wait scripts, workflows, declarations, or
  tests.
