# CurseForge listing draft

This is the text for the CurseForge (and Wago) project page. It is not part of the addon zip: `.pkgmeta` leaves `docs/` out.

**Name: TBD.** The listing must not be branded as Claude and must not use Anthropic's logo. Use "for Claude" wording, for example "<Name> for Claude". The toc `## Title:` is `Claude WoW` today; change it to the final name before the first upload, so the AddOns screen and the listing agree.

## Fields

| Field | Value |
|---|---|
| Name | TBD ("<Name> for Claude") |
| Summary (one line) | Chat with Claude Code and other AI coding agents from inside the game. Needs the free claude-wow companion program. |
| Game versions | World of Warcraft Classic (Classic Era, 1.15.x) and World of Warcraft: Forever (1.60.x). The toc says `## Interface: 11509, 16001`. |
| Main category | Chat & Communication |
| Other categories | Development Tools, Map & Minimap |
| License | MIT |
| Source | the project's GitHub repository (the project's Source URL field, not the description) |
| Logo | TBD: not the Claude or Anthropic logo |

Check the category names against the CurseForge form when you create the project; they are a proposal.

## Description

> **This addon needs a companion program.** It does nothing on its own. You also need the free **claude-wow** bridge, which runs on the same computer as the game, and an AI agent you have logged in to, such as Claude Code. Get the bridge from the claude-wow project on GitHub (rdimascio/claude-wow); its README has a one-line installer for macOS, Linux and Windows, and a Homebrew formula.

**<Name> for Claude** lets you talk to an AI coding agent from inside World of Warcraft. Send a task, go back to questing, and get a whisper in game when the answer is ready. No alt-tab.

**What it does**

- A **Claude** tab in your chat dock. Type a message there and it goes to your agent, never to the game server. The reply comes back as a whisper.
- Several chats at once. Each chat is its own agent session with its own agent (Claude Code, Codex, Grok Build, Antigravity or Hermes), and each chat can have its own folder.
- Live progress while the agent works: time, number of actions, and the file it is editing (not for Hermes, which reports only when it is done).
- The agent knows your character, level, zone, professions and quest log (you can turn this off). Shift-click items, spells and quests into a message.
- Routes and marks on your world map, with an arrow that walks you from stop to stop.
- Ready-made macros: ask for one and click **Create macro** to save it.
- **Need / Greed / Pass** on permissions: when Claude Code or Grok Build wants to run a command you have not allowed, it comes up as a loot roll.

**How it works**

Addons cannot use the network or read files while the game runs. The addon sends your message as a screenshot that the bridge reads, and the bridge writes the reply into small helper addons that the game loads on demand. Nothing injects code, reads game memory, or presses keys for you. The addon uses only documented addon functions.

**Install**

1. Install this addon.
2. Install the claude-wow bridge (see the companion note above).
3. Run `claude-wow setup`. It finds the game and creates the helper addons (`ClaudeWoW_Runtime` and 200 `ClaudeWoW_S###` slot addons). If you play Classic Era and also have Forever installed, run `claude-wow setup --wow "<path to World of Warcraft>/_classic_era_"`.
4. Fully quit the game and start it again once. A `/reload` does not add new addon folders.
5. Leave the *Claude WoW slot* addons enabled, start the bridge with `claude-wow`, and type `/claude hello` in game. The default agent is Claude Code; if you use only Codex, type `/claude --agent codex hello`.

**Known limits**

- On Classic Era, progress and replies arrive at the addon's scheduled checks (5, 10, 16 s and so on after you send), not at once.
- Your agent runs on your computer with your account and your permission settings. The addon only shows what it does.

Not affiliated with or endorsed by Anthropic. Claude is a trademark of Anthropic. This is an independent community project.
