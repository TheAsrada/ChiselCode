---
name: skill-creator
description: >
  Create and improve Agent Skills for ChiselCode. Use when the user wants to
  create a skill, turn a workflow into reusable instructions, revise an existing
  skill, or improve its triggering rules, even without an explicit slash command.
---

# Skill Creator

Create new ChiselCode skills and iteratively improve existing ones.

The overall process is:

- Understand what the skill should do and how it should work.
- Write a draft.
- Develop two or three realistic test prompts and try them yourself.
- Review the results with the user and refine the skill.
- Repeat as needed, then improve the `description` for accurate triggering.

Identify the user's current stage and help them move forward. For "I want a
skill for X", clarify the task, draft the skill, and evaluate it. If a draft
already exists, move directly to evaluation and iteration. Be flexible: if the
user asks you to skip tests and just create the skill, follow that preference.

## Language and communication

These authoring instructions are written in English; that does not determine
what language the generated skill should use.

- Use the user's language from the current conversation for explanations and
  newly created skills. An explicit request for another output language takes
  precedence. If the conversation is in Russian, create the skill in Russian;
  if it is in English, create it in English. Apply the same rule to other
  languages. Ask only if the intended language is genuinely ambiguous.
- Write the generated skill's `description`, Markdown instructions, explanations,
  examples, and human-facing reference material in that language. Do not copy
  English prose from these instructions or templates merely because it is here.
- Keep `name` and the folder name as a valid lowercase Latin slug. Preserve YAML
  field names, tool names, API identifiers, commands, paths, and the argument
  placeholder.
  Language selection does not change the skill format.
- When updating an existing skill, preserve its language unless the user asks
  for a translation or another language.

Communicate plainly and directly. Adapt terminology to the user's experience:
use technical terms when they are familiar, otherwise explain them briefly.

## Creating a skill

### Understand the intent

The conversation may already contain a workflow to capture, such as "turn this
into a skill". Extract the tools, step order, user corrections, and input/output
formats from that history before asking questions. Clarify material gaps that
cannot be inferred; proceed when the task is clear.

1. What should the skill enable the agent to do?
2. When should it trigger: which requests and contexts?
3. What output format is expected?
4. Would test cases help? Objectively checkable outputs, such as file
   transformations, extraction, code generation, or fixed procedures, benefit
   from tests. Subjective outputs, such as writing style or design, may need
   qualitative review instead. Recommend an approach and respect the user's
   testing preference.

### Research and clarify

Consider edge cases, input/output formats, sample files, success criteria, and
requirements before writing test prompts. Inspect relevant context using the
available tools: similar advertised skills through `load_skill`, references,
and established practices. Research first so the user has fewer gaps to fill.

## Skill destination

Skills created by this workflow are user skills. Create and update them only
in the directory ChiselCode determines through `userSkillsDir()`:

```text
<ChiselCode Home>/skills/user/<skill-name>/
```

For a standard Windows installation, ChiselCode Home is
`%LOCALAPPDATA%\ChiselCode`, giving this layout:

```text
%LOCALAPPDATA%\ChiselCode\
└── skills\
    ├── bundled\
    │   ├── skill-creator\
    │   └── code-review\
    └── user\
        └── my-skill\
            └── SKILL.md
```

For example, save `release-helper` as
`<ChiselCode Home>/skills/user/release-helper/SKILL.md`. Its `references/`,
`scripts/`, and `assets/` belong in the same skill directory.

Use `create_skill({name, files})` to create a skill and
`create_skill({name, files, mode: "update"})` to update an existing user skill.
Supply `SKILL.md` and supporting files as relative keys in `files`. ChiselCode
calls `userSkillsDir()` and constructs the destination itself. Do not infer
ChiselCode Home from the current project or use ordinary `write_file` with an
absolute path to save a skill.

`skills/bundled` is managed by the application. Do not create skills there or
replace bundled skills. If a name conflicts with a reserved bundled skill,
ask for a different name. Do not create skills in the current project: project
directories are no longer ChiselCode skill sources.

The folder name is the skill name, such as `deploy`. Built-in commands such as
`/settings`, `/model`, and `/skills` cannot be overridden. If a skill should be
available only to the model, add `user-invocable: false` to its frontmatter. If
it should be available only through manual invocation, add
`disable-model-invocation: true`. These settings are independent. Omit both
fields when both model selection and the manual command should be available.

## SKILL.md format

Start with YAML frontmatter between `---` markers, followed by Markdown
instructions. This example is in English; localize its prose to the user's
language when creating a skill:

```markdown
---
name: deploy
description: >
  Deploy a service. Use when the user asks to deploy, release a version,
  or update staging.
---

# Deploy

1. Check `git status`: the working tree should be clean.
2. Build the project: ...
3. Deploy: ...
```

Field requirements:

- `name`: lowercase Latin letters, digits, and hyphens; no leading, trailing,
  or consecutive hyphens; at most 64 characters; matches the folder name.
- `description`: explain what the skill does and when to use it. This is the
  main trigger: the agent reads available names and descriptions to decide
  which skill to open. Put triggering information here, rather than burying
  it in the body. Be specific enough to avoid underuse. Instead of "Build a
  dashboard", describe the relevant requests: dashboards, visualization,
  internal metrics, or presenting company data, even if the user does not say
  "dashboard". Keep the description within 1024 characters.
- `user-invocable: false` hides `/name` while retaining model loading.
  `disable-model-invocation: true` hides the skill from the model while
  retaining `/name`. Without either field, both paths are available.
  `load_skill` loads only skills visible to the model.
- Optional fields: `license`, `compatibility` for requirements such as network
  access or packages, `metadata` as a string dictionary, and experimental
  space-separated `allowed-tools`.

## Skill anatomy

```text
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name and description required)
│   └── Markdown instructions
└── Optional resources
    ├── scripts/    - executable code for deterministic tasks
    ├── references/ - documentation loaded as needed
    └── assets/     - output templates, icons, fonts, and similar files
```

### Progressive disclosure

There are three levels of context:

1. **Metadata**: names and descriptions in the model's catalog, roughly
   100 words per skill, used to decide which instructions to load.
2. **SKILL.md body**: loaded by name through `load_skill` when relevant.
   Keep it under 500 lines.
3. **Resources**: supporting materials used as needed. Ordinary `read_file`
   cannot read personal files outside the project. Until a dedicated safe
   resource loader exists, keep essential instructions in `SKILL.md` itself.

Do not move required instructions into `references/`, `scripts/`, or `assets/`
while that loader is unavailable. Those files can support the skill, but the
workflow should remain usable from `SKILL.md` alone. Add a table of contents
for reference files longer than 300 lines. Organize multiple domains by variant:

```text
cloud-deploy/
├── SKILL.md (workflow and variant selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```

Use only the references relevant to the task, subject to the resource-loading
limits above.

## Safety

Do not create skills for malware, unauthorized access, data theft, deception,
or other harmful purposes. A skill's behavior should match its stated intent
and should not surprise the user when explained plainly. Benign role-play is
fine. Loading a skill does not grant tool permissions or bypass approvals.

## Writing instructions

Use concrete, imperative steps, commands, and expected output formats.
Localize human-facing text in templates and examples to the selected language.

Define output formats with a template, for example:

```markdown
## Report structure
Use this report structure:
# [Title]
## Summary
## Key findings
## Recommendations
```

Show examples as input/output pairs:

```markdown
## Commit format
**Example 1:**
Input: added JWT authentication
Output: feat(auth): add JWT authentication
```

Document common mistakes and how to avoid them. Update these pitfalls when an
agent encounters the same problem repeatedly.

The argument placeholder (a dollar sign followed by `ARGUMENTS`) in the body
is replaced with the arguments of `/name args`.
Without that placeholder, the arguments are appended on a new line.

## Style

Explain why a step matters instead of relying on rigid, all-caps rules. Write
for a range of realistic uses, rather than one example. Draft, reread, and
refine. If the instructions accumulate "ALWAYS", "NEVER", or brittle
constraints, explain the underlying reason so the model can apply it sensibly.

## Evaluation

1. Show the user the complete draft `SKILL.md`.
2. Propose two or three realistic prompts, such as reviewing changes or
   deploying to staging. Agree on material changes to the test scope and
   respect testing preferences already given by the user.
3. Try each case following the skill. For comparison, run the same case
   without the skill when it is new, or with a saved snapshot of the previous
   version when improving one. Keep tests isolated and retain normal tool
   approvals; a test is not permission to perform unrelated external actions.
4. Show the results side by side and ask for concrete feedback on what to
   keep or change. Do not interpret silence as approval for another action.

## Iterating on feedback

1. **Generalize rather than patching individual examples.** A skill should
   support many uses, even though evaluation uses only a few cases. For a
   recurring problem, try a different explanation or workflow instead of
   adding increasingly narrow constraints.
2. **Keep instructions lean.** Review both the outputs and the steps taken.
   Remove text that sends the agent through unnecessary work.
3. **Explain why.** Understand the user's task and carry that understanding
   into the instructions, even when feedback is brief.
4. **Identify repeated work.** If multiple trials independently produce the
   same helper script or procedure, consider a reusable supporting script,
   subject to the resource-loading limits described above.

After changes, repeat relevant cases and review the results. Stop when the
user is satisfied, the requested work is complete, or further iteration is
not producing useful improvements.

## Optimizing the description

Once the skill works, offer to improve its description, which controls when
the agent selects it from the catalog.

1. Develop about 20 realistic requests: half should trigger the skill and
   half should not. Include concrete paths, names, context, varied lengths,
   typos, and conversational language. "Format the data" is too vague; a
   request about a specific quarterly sales spreadsheet and its margin
   columns is more useful. Write these cases in the user's language.
2. Focus on near misses: shared vocabulary with a different task, adjacent
   domains where keyword matching would be wrong, and cases better served
   by another tool. Obviously unrelated negative examples test little.
3. Share the proposed cases and incorporate the user's corrections.
4. Evaluate each request against the current description. Revise misleading
   wording and try again. Exclude trivial one-step requests, such as reading
   one file, for which a skill may be unnecessary regardless of description.
5. Update the frontmatter and show the before/after descriptions.

## Current request

When loaded through `load_skill`, use the user's current request from the
conversation. For a manual slash invocation, its arguments appear below:

$ARGUMENTS
