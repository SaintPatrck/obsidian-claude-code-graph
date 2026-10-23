# Claude Code Graph

An Obsidian plugin that turns a vault rooted at `~/.claude/projects` into a connected graph of your Claude Code history.

Claude Code stores each project's memories, session transcripts, subagent transcripts, and persisted tool output as plain files. Obsidian only draws graph edges from links inside Markdown notes, so out of the box those files show up as hundreds of disconnected attachment nodes. This plugin derives the relationships from Claude Code's directory layout and transcript contents and adds them to the graph, without writing anything to disk.

## Graph structure

```
Project
├── Memories (memory/*.md)
└── Session logs (<session>.jsonl)
    ├── Subagent logs (<session>/subagents/agent-*.jsonl)
    │   ├── Subagent metadata (agent-*.meta.json)
    │   └── Tool results produced by that subagent
    ├── Workflow runs (<session>/subagents/workflows/wf_*)
    │   ├── Run record (<session>/workflows/wf_*.json)
    │   ├── Run script (<session>/workflows/scripts/*-wf_*.js)
    │   ├── Run journal (journal.jsonl)
    │   └── Workflow agent logs (agent-*.jsonl)
    │       ├── Agent metadata (agent-*.meta.json)
    │       └── Tool results produced by that agent
    └── Tool results produced by the main session
```

Each project directory and workflow run folder appears as its own hub node, so a run's agents stay grouped under the session that started it. Tool results are matched to the transcript that recorded their saved path, so output produced by a subagent attaches to that subagent instead of the session that spawned it. A newly written tool result attaches to its session until its producing log is found a few seconds later.

## Colors

Obsidian's graph color groups don't apply to attachments, which covers every file type above, so the plugin colors these nodes itself:

| Node | Color |
|---|---|
| Project | Amber |
| Workflow run | Pink |
| Run record, script, or journal | Light pink |
| Session | Blue |
| Subagent or workflow agent | Violet |
| Agent metadata | Teal |
| Tool result | Slate |

Memory notes are left alone, so graph color groups still work for them. To change the palette, edit the `COLORS` block at the top of `main.js`.

## Installation

Open `~/.claude/projects` as an Obsidian vault, then install with [BRAT](https://github.com/TfTHacker/obsidian42-brat), which also keeps the plugin updated:

1. In Settings, open Community plugins, turn off Restricted mode, then browse for and enable BRAT.
2. Run the "BRAT: Add a beta plugin for testing" command and enter `SaintPatrck/obsidian-claude-code-graph`.
3. Enable Claude Code Graph under Community plugins.

To install manually instead, download `main.js` and `manifest.json` from the latest release into `~/.claude/projects/.obsidian/plugins/claude-code-graph/` and enable the plugin.

In the graph view's Filters, enable Attachments so transcript and tool-output nodes are shown.

## How it works

The plugin writes its links into Obsidian's in-memory link cache and adds each project folder to the in-memory file cache so it renders as a node. Node colors are applied as the graph receives its data. None of these hooks are part of Obsidian's public plugin API, so an Obsidian update can break the plugin. Everything is rebuilt whenever files are created, renamed, or deleted, and removed when the plugin is disabled.

## License

MIT
