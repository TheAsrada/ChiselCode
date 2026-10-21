---
name: extension-creator
description: >
  Create ready-to-enable ChiselCode extensions and UI mods. Use when the user
  wants to customize the interface, add a panel or controls, replace or hide
  interface elements, or build an extension, even without an explicit command.
---

# Extension Creator

Build a working self-contained ChiselCode extension for the user's request.
Use the conversation's language for explanations, labels, descriptions and the
extension's README. Keep API names and Latin extension identifiers unchanged.
These instructions are in English; generated extensions need not be.

## Workflow

1. Infer the requested behavior from the conversation; clarify only material
   gaps. Identify the interface surfaces and whether tools are needed.
2. Prefer `kind: "ui"` for interface changes. These packages enable, disable,
   update and apply settings live. They may register UI contributions, details
   views, chat formatters, owned tools and cleanup through `ctx.add`. They may
   not register commands, services, agent event middleware, guards, context providers or themes. Their
   tools are UI actions, not additions to the model's tool catalog.
3. For model-visible tools, slash commands, runtime hooks or application themes,
   use a standard package (omit `kind`). It uses the existing restart lifecycle.
   Explain that requirement honestly; do not promise live activation for it.
4. Write a complete manifest and plain ESM `.mjs` files. Injected `sdk` provides
   runtime helpers. TypeScript may import **types only** from
   `chiselcode/extension-sdk`; bundle dependencies into `.mjs` before installing.
   Never import React, OpenTUI, ChiselCode private source, or a second renderer.
5. Check that the code actually handles the request, includes cleanup, preserves
   native input, and has a useful empty/error state. Do not create placeholders.
   `Composer` keeps the native editor and its input behavior. Use
   `{type:"native",props:{title,placeholder,borderStyle,borderColor,padding,fg,bg}}`
   to restyle the existing frame and editor, rather than stacking another border.
   `PromptHints`/`PromptControls` are separate sites. Native props never replace
   input callbacks, the draft or permission prompts. For forms and independent
   panels, use the interactive elements described below.
6. Call `create_extension` with a `files` object containing the complete
   `chisel-extension.json`, `index.mjs`, and optional README/assets/modules.
   This passively parses JavaScript and validates paths/import closure, then uses the
   atomic managed installer. It does **not** execute the factory, enable code,
   or grant trust. Bundle any macros before delivery; the tool rejects macro
   imports and never invokes a compiler on unapproved source. Do not write directly to the registry, approval receipts or
   managed store. Do not execute an unapproved package to "test" it.
7. Report the installed extension name and Settings → Extensions → Trust and
   enable. The user's enable review is the remaining step. Do not run approve,
   enable, change project policy, or claim the package is already running.
   If validation fails, fix the source and retry. Existing IDs are not silently
   overwritten: use the Settings update review for an installed package.

## Package contract

`chisel-extension.json`:

```json
{
  "schemaVersion": 1,
  "id": "personal.focus-panel",
  "version": "1.0.0",
  "apiVersion": 1,
  "kind": "ui",
  "entry": "index.mjs",
  "displayName": "Focus panel",
  "description": "A personal interface panel"
}
```

IDs have at least two dot-separated lowercase Latin components. `builtin.*`
and `core.*` are reserved. UI composition is available starting with ChiselCode
0.6.33; 0.6.32 does not support it. The `kind` field makes old hosts reject
unsupported packages. Newer SDK v1 features must be declared in manifest
`requires`, for example `["ui.controls","ui.panes","ui.nativeProps"]`. Available
features are `ui.controls`, `ui.style`, `ui.nativeProps`, `ui.panes`, `ui.media`,
`agent.events`; `sdk.capabilities` reports support. Old hosts reject the new
manifest field before import. Do not infer these features from API version 1
alone. Use only capabilities exposed by the user's current host.

A complete `index.mjs`:

```js
export default ({ sdk, manifest }) => ({
  id: manifest.id, version: manifest.version, apiVersion: 1,
  entry: manifest.entry,
  activate(ctx) {
    ctx.ui.register({
      id: "focus", slot: "render", surfaces: ["AbovePrompt"],
      scope: "conversation", title: "Focus panel",
      source: { snapshot() {
        return { revision: 1, state: "ready", render: {
          mode: "replace", content: {
            type: "box", border: true, padding: 1, tone: "accent",
            children: [{ type: "text", text: "One task at a time", bold: true }]
          }
        } };
      } }
    });
  }
});
```

Translate the example's labels to the user's language and implement their actual
request. Do not install this example unchanged for an unrelated task.

## Composition API

`ctx.ui.register({id, slot:"render", surfaces, scope, title, order?, actions?,
source:{snapshot(binding), subscribe?(binding,changed)}})`.
Snapshots: `{revision, state, render:{mode, content?}}`. Revisions must increase
when data changes; use a counter, not a clock. `state` is `loading`, `empty`,
`ready`, `stale`, `error`, or `unavailable`. Only ready patches apply; failure
restores the native UI and displays a notice. Subscribe must return
`{dispose(){...}}`; unsubscribe timers/listeners and respect `binding.signal`.
Providers are read-only. Never call tools, network, filesystem or a model while
producing a snapshot. Cache data through permitted tool executions instead.
`binding.read.ownerSummary()` gives background and helper counts;
`binding.read.subscribeOwner(changed)` subscribes to changes. Keep conversation
state keyed by `binding.conversationId`; do not share it between conversations.

Modes: `before` or `after` adds content around the preceding layer; `replace`
replaces it; `hide` removes it and has no content. A replace tree may contain
`{type:"native"}` **once** to wrap previous layers, including other extensions.
Ordering is `order` (0–100, default 50), extension ID, contribution ID. Do not
rebuild another extension's content. Keep trees small and stable across updates.

Nodes:

- `text`: `text` (≤2000 characters), optional `tone`, `bold`.
- `value`: structured surface `field` (`text`, `title`, `state`, `count`, `path`),
  optional `tone`, `maxLength` (1–20000). Unknown fields are empty. No parsing of
  rendered lines or execution of templates.
- `box`: `children`, optional `direction` (`row`/`column`), `gap` (0–3), `padding`
  (0–2), `border`, `tone`, `grow` (boolean). Use `grow:true` when wrapping the
  expanding transcript. Rows may wrap; prefer columns for narrow panels.
- `button`: `label`, `action:{id,args?}`, optional `tone`.
- `native`: the preceding host/layer content, only for replace. Optional `props`
  changes supported native style/title/placeholder, preserving host behavior.
- `input`: required stable `key`, `label`, `value`; optional `placeholder`,
  `maxLength`, `onChange:{id,args?}`, `onSubmit:{id,args?}`, `disabled`.
- `select`: `key`, `label`, `options:[{value,label,description?}]`, `value?`,
  `onSelect:{id,args?}`, `disabled?`. Option values must be unique.
- `markdown` and `code`: `text` (up to 20000 characters); code accepts `language`.
- `image`: `data` contains base64 bytes, never a URL/path; `alt`, optional `fit`.
  Size belongs to `style.width/height`; decoded images are bounded to 1048576 pixels.
- `canvas`: `key`, `label`, `rows` of segment arrays `{text,fg?,bg?}`;
  `onPointer`/`onKey` refer to owned handlers. Use it for a custom animated or
  pointer-driven terminal region; dispose timers and subscriptions.

Every node may have a stable `key` (UI ID). Sibling keys must be unique; do
not change keys when labels change. Use keys for reorderable lists. Input, select
and canvas keys must also be unique throughout the contribution tree.

Use semantic tones: `muted`, `accent`, `success`, `warning`, `error`. Each node
also accepts `style`: local `fg/bg` as a theme token or `#RRGGBB`, dimensions,
flex grow/shrink, padding/gap, borders/alignment and text attributes. Prefer
palette tokens so both themes remain readable. No raw terminal escapes,
absolute coordinates, palette mutation, global listeners or JSX.
Trees allow ≤128 nodes, depth ≤8, ≤32 children per box. Existing source limits
still apply (64 KiB per snapshot, 256 KiB total cache, 2-second cooperative
provider deadline, 10 updates/second). A source may list multiple surfaces.

Surfaces:
`App`, `WorkspaceTabs`, `Header`, `Home`, `HomeLogo`, `HomeHints`, `Main`,
`Transcript`, `UserMessage`, `AssistantMessage`, `SystemMessage`, `ToolActions`,
`Skills`, `FileDiff`, `ChatCard`, `CommandOutput`, `Compaction`, `RequestStatus`,
`ToolProgress`, `Composer`, `PromptHints`, `PromptControls`, `AbovePrompt`,
`BelowPrompt`, `StatusLine`, `Sidebar`, `SidebarMenu`, `ContextPanel`, `AgentTree`.
`App`, `Main`, `Home`, `Composer` and visible errors retain native content
exactly once; use wrappers there. Customization never hides permission prompts,
trust/settings dialogs or takes over the native editor. Hidden normal surfaces
can still be reached through the host's keyboard navigation where applicable.

For an independent panel use `slot:"pane",placement:"sidebar"` (or
`above_prompt`/`below_prompt`), without `surfaces`. Use a ready render snapshot,
no native embedding. Sidebar panels work with the built-in sidebar closed;
the host reserves their width and moves them above the prompt on narrow screens.
The host supplies collapse/expand through the header and Alt+U.

## Actions and views

Declare `actions:[{id:"open", label:"Open", type:"view", viewId:"details"}]`
and `ctx.ui.registerView({id:"details", scope:"conversation", title:"Details",
page(binding,request){return {revision:1,state:"ready",summary:"..."}}})`.
A button's action must match a declared action. Register owned tools for actual
file/process actions and use `{id,label,type:"tool",tool:"local_tool_name"}`.
UI dispatch preserves tool permissions, Plan/Build, approvals, owner queues and
cancellation; never bypass them with direct filesystem/process calls. Keyboard
users can open shown controls and panel actions with Alt+U. Enter chooses a
field; Tab/Shift+Tab move between shown controls, Escape returns to chat.
Buttons can declare `hotkey`, e.g. `alt+s`, scoped to their extension region.
Do not override normal text-editing chords. Core cancellation, tabs, settings
and permission input retain priority.

Register local handlers once with `ctx.ui.on("name",(binding,event,args)=>{})`.
Inputs emit `change`/`submit` with `value`, selects emit `select` with `value`
and `index`; canvas emits `pointer` (`x,y,button`) or `key` (name/sequence and
modifiers). Buttons may declare `{id,label,type:"event",eventId:"name"}` to emit
`press`. Update activation-owned state, increment revision and notify subscribers;
no model request is needed. Keep state keyed by conversation ID. The callback's
`binding.presentation` identifies the concrete surface/instance and structured
values when a control is repeated in transcript rows. Never parse painted lines.
Callbacks are serialized per UI binding; errors restore a visible fallback.
Use a tool action for effects, never raw filesystem/process calls in UI handlers.

Tool definitions use `sdk.defineTool({name,description,effect,inputSchema,
prepare(invocation,input),execute(invocation,plan)})`, registered with
`ctx.tools.register(tool)`. Effects: `read`, `workspace_write`, `process`.
Prepare must return `invocation.plan.readText(path)`, `.writeText(path,content)`
or `.shell(command,options?)`; execute runs the captured plan through
`invocation.effects.run()`. Match the declared effect to the plan. Do not fake
plans or mutate the workspace in preparation/provider callbacks.

Optional manifest settings use `{fields:[{name,type,label,default,...}]}`.
Read with `await sdk.settings.read()` inside activation. UI settings remount the
UI scope with a fresh settings snapshot, not the application's core services.
Keep local state in activation, never in module-global mutable singletons.

## Agent event middleware (standard packages)

Require `agent.events`; do not use `kind:"ui"` for runtime hooks. The standard
package may own both a pane and event handlers; explain the required restart.
`ctx.events.on(type,async(event,next)=>...)` receives frozen `data`, `sessionId`,
optional `turnId`, `workspaceRoot`, and `signal`. Use `next()` or `next(data)`
once during the handler, or return a synthetic decision without continuing.

- `prompt.submit`: data/result `{text}`.
- `model.request`: data `{model,system,messages,maxTokens?}`; return `{request:data}`
  or `{response:{message,stopReason,usage?}}` without contacting a model. Model
  selection is within the current provider and request; output budget cannot grow.
- `model.response`: data/result `{message,stopReason,usage?}`. The host preserves
  real usage/refusal and buffers text until the filter is complete.
- `tool.call`: data `{callId,name,input}`; return `{call:data}` or
  `{result:{output,isError?,errorCode?,preview?,rawOutput?,details?}}`. Do not
  change `callId`. Rewritten calls still go through core preparation/permissions.
- `tool.result`: data `{callId,name,result}`; return `{result}` after a successful
  effect. Original failures/denials are protected. The actual result is durable
  before a post-effect hook waits; a failed formatter cannot undo a completed write.

`ctx.events.observe(event=>...)` reads sanitized runtime events and updates cached
UI state keyed by session/call identity. A faulty observer is disabled separately.
For a pause awaiting an owned UI button, honor the handler's signal and clear the
pending promise in cleanup. No direct permission grant, receipt forgery or replay.
Internal context summaries are outside this API. Do not describe synthetic output
as a tool that actually ran.

## Current request

$ARGUMENTS
