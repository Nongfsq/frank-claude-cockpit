# frank-claude-cockpit

One Claude Code mod, `context-card`, published as a plugin marketplace (`pr-pane` was retired in favour of `/ship`; it lives in git history). This repository is the source of truth; `~/.claude/skills/<mod>` holds the installed copies.

## Working on a mod

- Load the `plugin-authoring` skill before editing a hooks module; it names this build's API declarations.
- Edit the mod here, then validate, test and install it in one step: `claude-mod-sync context-card` (run from the repo root; it refuses to install a mod that fails).
- An installed change reaches a session only when that session starts. To see edits live, copy the mod into the session's hot-reload folder that `plugin-authoring` names, and copy the result back here when done.
- The desktop surface cannot be driven from a session: ask the user for a screenshot rather than assuming how it renders.

## Desktop rendering limits

Probed on 2.1.330: five text sizes, backgrounds, borders, spacing steps, button variants, a native dropdown (`Select`), `Input`, `Progress` and `Svg` all draw. Catches: `Progress` has no track, an interactive `Svg` needs explicit `width`/`height`, dim text inside a button label is not dimmed, and medium/semibold/bold look alike. The list is on the "Desktop limits and rules" board of the design canvas: https://claude.ai/artifact/GN7oKbqBksp8LHUiUcZgWW

- A click target over a whole line is a label-less plain Button in an absolutely positioned box, wider than the line so the parent clips it; a truncated label draws a stray ellipsis.
- Status marks use only `●`, `◐` and `○`: other pie glyphs come from a fallback font and sit off-centre.

## Releasing

- Bump `version` in the changed mod's `.claude-plugin/plugin.json`, commit, tag `<mod>-vX.Y.Z` with that mod's version (`context-card-v0.1.3`), push the branch and the tag. Ask before pushing. The plain `v0.1.0`–`v0.1.4` tags are older repo-wide releases; leave them as they are.
- When the interface changes, re-record the demo: see "Development" in the README.
- Demo data and test fixtures are invented (project "Atlas", tasks `API-142`); never use real project or task names.
