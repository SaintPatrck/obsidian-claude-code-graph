const { Plugin, TFile, TFolder, Vault } = require("obsidian");

// Each Claude Code project directory becomes the hub for its memories and
// session logs. Each session links to the subagent transcripts Claude Code
// writes to <session>/subagents/agent-*.jsonl, each subagent to its
// agent-*.meta.json, and each persisted tool result to the log that produced it.
// Workflow runs write their agents and journal to
// <session>/subagents/workflows/wf_*/ and their run record and script to
// <session>/workflows/, all named by run id, so each run folder sits between
// the session and those files to keep a run grouped.
//
// Obsidian's graph only draws edges from Markdown links and only draws nodes
// for paths in the metadata cache, so we inject both directly. Project and
// workflow run folders are added to the in-memory file cache to render as
// nodes; writing the entry directly (rather than through saveFileCache) keeps
// it out of the persisted IndexedDB cache.
//
// Graph color groups never apply to attachments, which covers every node type
// here, so node colors are assigned as the data reaches each graph renderer.

const COLORS = {
  project: 0xf5a623,
  workflow: 0xec4899,
  workflowFile: 0xf9a8d4,
  session: 0x3b82f6,
  subagent: 0x8b5cf6,
  meta: 0x14b8a6,
  toolResult: 0x94a3b8,
  pluginAgent: 0xef4444,
};

// Subagents are colored by the agentType in their metadata. Types not listed
// fall back to pluginAgent when namespaced by a plugin, otherwise subagent.
const AGENT_COLORS = {
  "workflow-subagent": 0xc4b5fd,
  Explore: 0x22d3ee,
  Plan: 0x22d3ee,
};

const ORIGIN_RETRY_DELAY_MS = 5000;

module.exports = class ClaudeCodeGraph extends Plugin {
  async onload() {
    this.injectedLinks = new Map();
    this.injectedNodes = new Map();
    this.origins = new Map();
    this.agentTypes = new Map();
    this.patchedRenderers = new Map();
    this.syncing = false;

    this.app.workspace.onLayoutReady(() => {
      this.patchRenderers();
      this.sync();
      this.resolveOrigins();
      this.loadAgentTypes();
      this.registerEvent(this.app.metadataCache.on("resolved", () => this.sync()));
      this.registerEvent(this.app.vault.on("create", (file) => this.onCreate(file)));
      this.registerEvent(this.app.vault.on("delete", (file) => this.onRemove(file.path)));
      this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRemove(oldPath, file)));
      this.registerEvent(this.app.workspace.on("layout-change", () => {
        if (this.patchRenderers()) this.sync();
      }));
    });
  }

  onunload() {
    clearTimeout(this.originTimer);
    for (const [renderer, setData] of this.patchedRenderers) renderer.setData = setData;
    this.patchedRenderers.clear();
    this.clear();
    this.app.metadataCache.trigger("resolved");
  }

  onCreate(file) {
    // The log line naming a persisted tool result is appended after the file
    // itself is written, so origin lookup waits for the log to catch up.
    if (this.toolResultParts(file.path)) {
      clearTimeout(this.originTimer);
      this.originTimer = setTimeout(() => this.resolveOrigins(), ORIGIN_RETRY_DELAY_MS);
    }
    if (this.category(file.path) === "meta") this.readAgentType(file.path).then(() => this.sync());
    else this.sync();
  }

  onRemove(path, renamed) {
    this.origins.delete(path);
    if (renamed) this.onCreate(renamed);
    else this.sync();
  }

  toolResultParts(path) {
    const parts = path.split("/");
    if (parts.length < 4 || parts[2] !== "tool-results") return null;
    return { sessionDir: `${parts[0]}/${parts[1]}`, anchor: `tool-results/${parts[3]}` };
  }

  workflowParts(path) {
    const parts = path.split("/");
    const sessionDir = `${parts[0]}/${parts[1]}`;
    let runId = null;
    if (parts.length === 6 && parts[2] === "subagents" && parts[3] === "workflows") runId = parts[4];
    else if (parts.length === 4 && parts[2] === "workflows") runId = parts[3].match(/^(wf_[^.]+)\.json$/)?.[1];
    else if (parts.length === 5 && parts[2] === "workflows" && parts[3] === "scripts") runId = parts[4].match(/-(wf_[^.]+)\.js$/)?.[1];
    if (!runId) return null;
    return { sessionPath: `${sessionDir}.jsonl`, run: `${sessionDir}/subagents/workflows/${runId}` };
  }

  category(path) {
    const parts = path.split("/");
    if (this.injectedNodes.has(path)) return parts.length === 1 ? "project" : "workflow";
    const name = parts[parts.length - 1];
    if (parts.length === 2 && name.endsWith(".jsonl")) return "session";
    if ((parts[parts.length - 2] === "subagents" || this.workflowParts(path)) && name.startsWith("agent-")) {
      if (name.endsWith(".meta.json")) return "meta";
      if (name.endsWith(".jsonl")) return "subagent";
    }
    if (this.workflowParts(path)) return "workflowFile";
    if (this.toolResultParts(path)) return "toolResult";
    return null;
  }

  async loadAgentTypes() {
    const metas = this.app.vault.getFiles().filter((f) => this.category(f.path) === "meta");
    await Promise.all(metas.map((f) => this.readAgentType(f.path)));
    this.sync();
  }

  async readAgentType(metaPath) {
    try {
      const { agentType } = JSON.parse(await this.app.vault.adapter.read(metaPath));
      if (agentType) this.agentTypes.set(metaPath.slice(0, -".meta.json".length) + ".jsonl", agentType);
    } catch {
      // A metadata file caught mid-write keeps its agent's default color.
    }
  }

  color(path, category) {
    if (category !== "subagent") return COLORS[category];
    const type = this.agentTypes.get(path);
    if (type && Object.hasOwn(AGENT_COLORS, type)) return AGENT_COLORS[type];
    return type && type.includes(":") ? COLORS.pluginAgent : COLORS.subagent;
  }

  // Claude Code records each persisted output's full path in the transcript
  // that produced it, so the first log mentioning tool-results/<entry> is the
  // origin. Subagent logs are searched first because they are more specific.
  async resolveOrigins() {
    if (this.resolving) {
      this.resolveAgain = true;
      return;
    }
    this.resolving = true;
    try {
      const pending = new Map();
      for (const file of this.app.vault.getFiles()) {
        if (this.origins.has(file.path)) continue;
        const tr = this.toolResultParts(file.path);
        if (!tr) continue;
        if (!pending.has(tr.sessionDir)) pending.set(tr.sessionDir, []);
        pending.get(tr.sessionDir).push({ path: file.path, anchor: tr.anchor });
      }

      let found = false;
      for (const [sessionDir, items] of pending) {
        const subagentsDir = this.app.vault.getAbstractFileByPath(`${sessionDir}/subagents`);
        const logs = [];
        if (subagentsDir instanceof TFolder) {
          Vault.recurseChildren(subagentsDir, (f) => {
            if (f instanceof TFile && f.extension === "jsonl" && f.name.startsWith("agent-")) logs.push(f.path);
          });
        }
        logs.push(`${sessionDir}.jsonl`);

        const remaining = new Set(items);
        for (const log of logs) {
          if (remaining.size === 0) break;
          if (!(this.app.vault.getAbstractFileByPath(log) instanceof TFile)) continue;
          const content = await this.app.vault.adapter.read(log);
          for (const item of remaining) {
            if (!content.includes(item.anchor)) continue;
            this.origins.set(item.path, log);
            remaining.delete(item);
            found = true;
          }
        }
      }
      if (found) this.sync();
    } finally {
      this.resolving = false;
    }
    if (this.resolveAgain) {
      this.resolveAgain = false;
      this.resolveOrigins();
    }
  }

  // Returns true when a renderer was newly patched so the caller can redraw.
  patchRenderers() {
    let patched = false;
    for (const type of ["graph", "localgraph"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const renderer = leaf.view && leaf.view.renderer;
        if (!renderer || this.patchedRenderers.has(renderer)) continue;
        const setData = renderer.setData;
        renderer.setData = (data) => {
          this.colorize(data);
          return setData.call(renderer, data);
        };
        this.patchedRenderers.set(renderer, setData);
        patched = true;
      }
    }
    return patched;
  }

  colorize(data) {
    if (!data || !data.nodes) return;
    for (const id in data.nodes) {
      const node = data.nodes[id];
      if (node.type !== "attachment") continue;
      const category = this.category(id);
      if (category) node.color = { a: 1, rgb: this.color(id, category) };
    }
  }

  collect() {
    const links = new Map();
    const add = (source, target) => {
      if (!links.has(source)) links.set(source, new Set());
      links.get(source).add(target);
    };
    const isFile = (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile;
    const isFolder = (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFolder;

    for (const file of this.app.vault.getFiles()) {
      const parts = file.path.split("/");
      if (parts.length < 2) continue;
      const project = parts[0];
      const tr = this.toolResultParts(file.path);
      const wf = this.workflowParts(file.path);

      if (parts.length === 2 && file.extension === "jsonl") {
        add(project, file.path);
      } else if (parts.length === 3 && parts[1] === "memory" && file.extension === "md") {
        add(project, file.path);
      } else if (file.extension === "jsonl" && file.name.startsWith("agent-") && parts[parts.length - 2] === "subagents") {
        const sessionPath = parts.slice(0, -2).join("/") + ".jsonl";
        if (isFile(sessionPath)) add(sessionPath, file.path);
      } else if (file.name.startsWith("agent-") && file.name.endsWith(".meta.json") && (parts[parts.length - 2] === "subagents" || wf)) {
        const agentPath = file.path.slice(0, -".meta.json".length) + ".jsonl";
        if (isFile(agentPath)) add(agentPath, file.path);
      } else if (wf) {
        if (isFile(wf.sessionPath) && isFolder(wf.run)) {
          add(wf.sessionPath, wf.run);
          add(wf.run, file.path);
        }
      } else if (tr) {
        // Until the producing log is found, the session folder is the best
        // known origin.
        const origin = this.origins.get(file.path);
        const sessionPath = `${tr.sessionDir}.jsonl`;
        if (origin && isFile(origin)) add(origin, file.path);
        else if (isFile(sessionPath)) add(sessionPath, file.path);
      }
    }
    return links;
  }

  clear() {
    const cache = this.app.metadataCache;
    for (const [source, targets] of this.injectedLinks) {
      const entry = cache.resolvedLinks[source];
      if (!entry) continue;
      for (const target of targets) delete entry[target];
      if (Object.keys(entry).length === 0) delete cache.resolvedLinks[source];
    }
    for (const [path, stub] of this.injectedNodes) {
      if (cache.fileCache[path] === stub) delete cache.fileCache[path];
    }
    this.injectedLinks = new Map();
    this.injectedNodes = new Map();
  }

  sync() {
    // Triggering "resolved" re-enters this handler; the guard stops the loop.
    if (this.syncing) return;
    this.syncing = true;
    try {
      this.clear();
      const cache = this.app.metadataCache;
      this.injectedLinks = this.collect();

      for (const [source, targets] of this.injectedLinks) {
        if (this.app.vault.getAbstractFileByPath(source) instanceof TFolder && !cache.fileCache[source]) {
          const stub = { mtime: 0, size: 0, hash: "" };
          cache.fileCache[source] = stub;
          this.injectedNodes.set(source, stub);
        }
        const entry = (cache.resolvedLinks[source] ??= {});
        for (const target of targets) entry[target] = (entry[target] ?? 0) + 1;
      }
      cache.trigger("resolved");
    } finally {
      this.syncing = false;
    }
  }
};
