# yaros-skills

Personal Claude Code skills.

## Install

This repo is both a plugin and its own marketplace. In Claude Code:

```
/plugin marketplace add <github-user>/claude-skills
/plugin install yaros-skills@yaros-skills
```

Or locally for development:

```
claude --plugin-dir /path/to/claude-skills
```

## Skills

- **electron-debug** — Launch an Electron app headlessly via Playwright, capture main + renderer logs + pageerrors, optionally screenshot, then exit. Use to verify Electron apps boot cleanly after code changes. See [`skills/electron-debug/SKILL.md`](skills/electron-debug/SKILL.md).

## Adding a new skill

1. Create `skills/<skill-name>/SKILL.md` with frontmatter (`name`, `description`).
2. Add any helper files under `skills/<skill-name>/` (e.g., `scripts/`, `templates/`). Reference them from SKILL.md using `${CLAUDE_PLUGIN_ROOT}/skills/<skill-name>/...` so paths resolve regardless of which project the skill runs from.
3. Bump the version in `.claude-plugin/plugin.json`.
4. Commit and push.

## Layout

```
.claude-plugin/
  plugin.json        plugin manifest
  marketplace.json   marketplace manifest (so this repo installs directly)
skills/
  <skill-name>/
    SKILL.md
    scripts/ …       optional helpers
```
