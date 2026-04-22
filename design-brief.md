# Brief for Claude Design — graph-style output for aka

**Context.** `aka` is a tool where a user pastes a festival lineup and gets back, per artist, the other names they perform under and their side projects / group memberships. The current output is a list: one section for clusters of lineup entries that are the same act under different names, one section for entries with no match. I want to redesign the output as a **2-D layout of points** where each lineup entry is a point, points in the same cluster are visually grouped, and **lines between points carry labels describing the identity connection**. Non-lineup bridge people (e.g. a shared member) appear only as edge labels, never as points. Entries with no match sit alone on the canvas.

## Sample input (paste as-is)

```
Atmos
Battle of the Future Buddhas
Blue Planet Corporation
Doof
Eat Static
Growling Mad Scientists
Filteria
Ultravibe
1200mic
Bumbling Loons
Dickster
Etnica
Green Nuns of the Revolution
Pleiadians
```

## Expected output — two clusters and nine singletons

### Cluster 1: Dickster ↔ Bumbling Loons ↔ Green Nuns of the Revolution

Three points, fully connected (three edges). Each edge is labelled with the bridge person who links the pair:

- Dickster — Bumbling Loons, label: _"Dick Trevor — aka of Dickster, member of Bumbling Loons"_
- Dickster — Green Nuns of the Revolution, label: _"Dick Trevor — aka of Dickster, member of Green Nuns of the Revolution"_
- Bumbling Loons — Green Nuns of the Revolution, label: _"Dick Trevor — member of both"_

### Cluster 2: Etnica ↔ Pleiadians

Two points, one edge, **multiple pieces of evidence** on it (this is the main design challenge — edges can have 1 or N labels):

- _Maurizio Begotti — member of both_
- _Max Lanfranconi — member of both_
- _Carlo Paternò — member of both_
- _Andrea Rizzo — member of both_

### Singletons (no match found against anyone else on the lineup)

Atmos, Battle of the Future Buddhas, Blue Planet Corporation, Doof, Eat Static, Growling Mad Scientists, Filteria, Ultravibe, 1200mic.

## Edge-label vocabulary

Three relation types: `alias` (also known as), `member of` (person→group), `group of` (group→person, the inverse — rarely needed). Most real edges are two-hop: `A — aka — X — member of — B`. Sometimes one-hop: `A — aka — B` (would apply if someone's stage name and their legal name both appear on the lineup).

## Hypothetical single-hop example for layout purposes

If the lineup also contained "Dick Trevor," he would join Cluster 1 as a fourth point with three direct edges:

- Dick Trevor — Dickster, label: _"aka"_
- Dick Trevor — Bumbling Loons, label: _"member of"_
- Dick Trevor — Green Nuns of the Revolution, label: _"member of"_

## What to design for

- Clusters of 2–5 points; up to ~15 singletons floating around them.
- Edges with a **variable number of evidence labels** (1–6 typical).
- A "still loading" state — clusters appear incrementally, may merge with each other partway through.
