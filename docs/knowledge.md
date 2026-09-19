# Knowledge recipe

Read when an app keeps markdown knowledge in folders: a handbook, research notes, a second brain. The storage, permission and editing contracts are in [the app backend guide](app-backend.md#knowledge-files); this file is how to organize and maintain the content. It is optional per app, and the app chooses its folders and types.

## Format: OKF v0.2

Files follow the [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md) (pinned; v0.2 renamed fields from v0.1). Golem reads only `type` and `title` and preserves everything else.

- One concept per `.md` file. Its path without `.md` is its identity, so rename with care and fix the links that point at it.
- Each concept starts with YAML frontmatter holding a non-empty `type`. `title` and a one-sentence `description` are recommended. The app picks its own type names.
- Link concepts with ordinary markdown links, preferably from the root: `[Opening the workshop](/guides/opening.md)`. A link to a page not written yet is fine.
- `index.md` and `log.md` are reserved. `index.md` lists a folder's concepts under headings, one `* [Title](path) - description` line each, with no frontmatter (the root `index.md` may carry `okf_version: "0.2"`). `log.md` records changes newest first under `## YYYY-MM-DD` headings.

```markdown
---
type: Playbook
title: Opening the workshop
description: What to switch on, in order, before the first job of the day.
---
# Opening the workshop

1. Unlock the side door.
2. Switch on the dust extractor before any saw.
```

## Maintaining it

- **Agree the map first.** Before writing much, settle with the person which folders and types the domain needs. Add folders when material asks for them.
- **Capture, then organize.** New material goes in as it arrives, even rough. Tidy it in small steps: split a concept that covers two things, merge duplicates, add the links.
- **Keep sources.** Record where a claim came from with a link, or keep the original under `references/`, so an answer can be traced back to its source.
- **Keep indexes current.** When you add, rename or remove a concept, update the `index.md` of its folder in the same change and add a `log.md` line.
- **Answer from sources.** Search, read the files, and cite the path and lines you used. Say what is missing or looks out of date instead of filling the gap; offer to write it down.
- **Edit with the reader.** Read before writing and send the version you read. When a save is refused because the file changed, read it again and merge; never write over the other change.

Frontmatter such as `verified` or `status` is advisory. Who may read or change a file is decided only by the app's `authorize`.
