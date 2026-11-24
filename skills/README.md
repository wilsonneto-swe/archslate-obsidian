# Agent skill: system-design-diagram

This skill teaches an AI agent (Claude Code, the Claude apps, or any agent that reads instructions) to write system
design diagrams as Markdown notes that Archslate draws: a `archslate: diagram` property, an `archslate` code block
with the diagram's source, and the notes below it. With it, an agent can turn a request ("design a URL shortener"),
meeting notes or an existing description into a diagram in your vault, check a diagram, extend one without breaking
it, and save a version before a big change so you can see what changed.

```
system-design-diagram/
  SKILL.md                the instructions the agent reads (workflow, the language, what makes a good diagram)
  scripts/archslate.mjs   the CLI: validate, new, set, version, source (one file, Node 18 or later, no dependencies)
  reference/FORMAT.md     every rule of the language and of the note format
  examples/               two complete diagram notes
```

`archslate.mjs` is built from Archslate's own parser and file format, so a note it writes is exactly what the plugin
and the web app read, and `validate` prints the outline the diagram will show with each problem at its line in the
note. The skill is not part of the Obsidian plugin: Obsidian never loads it, and the plugin's releases (`main.js`,
`manifest.json`, `styles.css`) do not include it.

## Install in Claude Code

This repository is a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) with one plugin, `archslate`,
whose only part is this skill. Add the marketplace by its GitHub name, then install the plugin from it:

```
/plugin marketplace add wilsonneto-swe/archslate-obsidian
/plugin install archslate@archslate
```

From a terminal, the same is:

```
claude plugin marketplace add wilsonneto-swe/archslate-obsidian
claude plugin install archslate@archslate
```

Start a new session. Claude uses the skill when a request matches it (a system design, an architecture diagram, a
data flow); you can also name it: "use the archslate:system-design-diagram skill", or run
`/archslate:system-design-diagram`. To set it up for a project's team, run both terminal commands in the project
with `--scope project` added: they are recorded in the project's `.claude/settings.json`, and teammates who open the
project in Claude Code are asked to install it.

The plugin has no fixed version: each commit on `main` is a new one. To get the latest, run
`claude plugin marketplace update archslate`, then `claude plugin update archslate@archslate` (or use `/plugin` in a
session), and start a new session.

### Without the plugin

Claude Code also loads skills from `~/.claude/skills/` (every project) and from `.claude/skills/` inside a project
(that project only). Get this repository and copy the folder there:

```
git clone --depth 1 https://github.com/wilsonneto-swe/archslate-obsidian.git
mkdir -p ~/.claude/skills && cp -R archslate-obsidian/skills/system-design-diagram ~/.claude/skills/
```

(Or download the repository as a ZIP from GitHub, under **Code**, and copy `skills/system-design-diagram` from it.)
Start a new session; the skill is then `system-design-diagram`, with no prefix.

## Install in the Claude apps

Zip the `system-design-diagram` folder (the folder itself, with `SKILL.md` inside it) and upload it under
**Settings > Capabilities > Skills** (custom skills need a plan and settings that allow them). The CLI needs Node,
which the apps' code execution environment provides.

## Other agents

Point the agent at `SKILL.md` (paste it, or reference the file) and make `scripts/archslate.mjs` available to it.
Everything it needs is in this folder. `SKILL.md` names the folder `${CLAUDE_SKILL_DIR}`, which Claude Code fills in;
tell another agent where the folder is.

## Try it

- "Design a URL shortener in my vault, with the read path as a flow and capacity estimates below the diagram."
- "Turn these meeting notes about our checkout into an Archslate diagram." (paste the notes)
- "Add a cache in front of the database in `Orders platform.md`, save the current version first as 'before cache'."
- "Check `Chat app.md` and tell me what's wrong with it."
