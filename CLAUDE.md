# frank-claude-cockpit

Two Claude Code mods, `context-card` and `pr-pane`, published as a plugin marketplace. This repository is the source of truth; `~/.claude/skills/<mod>` holds the installed copies.

## Working on a mod

- Load the `plugin-authoring` skill before editing a hooks module; it names this build's API declarations.
- Edit the mod here, then validate, test and install it in one step: `claude-mod-sync context-card pr-pane` (run from the repo root; it refuses to install a mod that fails).
- An installed change reaches a session only when that session starts. To see edits live, copy the mod into the session's hot-reload folder that `plugin-authoring` names, and copy the result back here when done.
- The desktop surface cannot be driven from a session: ask the user for a screenshot rather than assuming how it renders.

## Desktop rendering limits

One text size; spacing only in whole cells and lines; no row backgrounds, custom icons or hover code. Details and the alignment rules are on the "Desktop limits and rules" board of the design canvas: https://claude.ai/artifact/GN7oKbqBksp8LHUiUcZgWW

- A click target over a whole line is a label-less plain Button in an absolutely positioned box, wider than the line so the parent clips it; a truncated label draws a stray ellipsis.
- Status marks use only `●`, `◐` and `○`: other pie glyphs come from a fallback font and sit off-centre.

## Releasing

- Bump `version` in the changed mod's `.claude-plugin/plugin.json`, commit, tag `vX.Y.Z`, push the branch and the tag. Ask before pushing.
- When the interface changes, re-record the demo: see "Development" in the README.
- Demo data and test fixtures are invented (project "Atlas", tasks `API-142`); never use real project or task names.
