# Handoff: aka — graph output redesign

## Overview

`aka` turns a festival lineup into a graph of identity connections: each lineup entry is a point, points that share members / aliases are connected by labelled edges, and entries with no match sit alone. This handoff redesigns the user flow from **text input** → **live progressive resolution** → **interactive graph output** as a two-screen single-page app.

The design has two screens:

1. **Input** — two fields for pasting a lineup (text / HTML) or linking one by URL
2. **Live resolution → graph** — a two-column view where the graph draws itself on the left as entries resolve, and a right panel shows detail when you click an edge

## About the design files

The files in this bundle are **design references written as HTML + React (via in-browser Babel)**. They are prototypes showing the intended look and behavior — not production code to copy directly.

**Your task is to recreate these designs in the aka codebase using its existing framework and patterns.** The HTML is a spec for the UI, not a drop-in implementation. If the codebase already has a framework (React, Vue, Svelte, plain JS, etc.), rebuild the components there idiomatically. If there's no UI layer yet, choose one appropriate to the project.

Open `Live Resolution.html` in a browser to explore the prototype. The flow:

- Click **Try an example ↓** on the input screen, then **Decode lineup** to see the graph.
- On the graph screen, the resolution animates automatically — click **Replay** (top right) to watch again.
- Click any edge to focus it in the right panel; expand the "Connected by N people" row to see evidence.
- Click the `←` next to the wordmark to return to the input.

## Screenshots

Reference captures of each state (in `screenshots/`):

| #   | File                     | What it shows                                                                               |
| --- | ------------------------ | ------------------------------------------------------------------------------------------- |
| 1   | `01-input-screen.png`    | Input screen, empty state                                                                   |
| 2   | `02-input-filled.png`    | Input screen with the example lineup pasted in                                              |
| 3   | `03-graph-resolving.png` | Graph screen mid-resolution (some nodes still pulsing accent, others dimmed; edges forming) |
| 4   | `04-graph-complete.png`  | Graph screen after resolution completes, with an edge focused in the right panel            |

## Fidelity

**High-fidelity.** Colors, typography, spacing, transitions, and interactions are all final. Recreate pixel-accurately using the codebase's idioms (component libraries, styling approach, etc.).

## Screens

### 1. Input screen (`input-screen.jsx`)

**Purpose.** Step 1: user pastes a lineup or links to one. No parsing happens in the prototype — the button just transitions to the graph view. In the real app, this is where you'll wire up the existing parser.

**Layout.**

- Full-viewport dark canvas with a subtle dotted grid background.
- **Top bar** (height 64px, `border-bottom: 1px solid #2a2824`, padding `0 32px`): left-aligned wordmark.
- **Main body**: centered content, `max-width: 720px`, padding `80px 32px 64px`.
  - **Hero block** (margin-bottom 56px):
    - Eyebrow: `01  Drop in a lineup` — mono, 10px, letter-spacing 0.18em, uppercase, accent color.
    - H1: "Who's actually on the bill?" — serif (Fraunces 600), 52px, letter-spacing -1.2px, line-height 1.05.
    - Body paragraph: sans, 16px, max-width 520px, `color: #7a766e` with the word "aka" in `#ece8df`.
  - **Paste lineup field**:
    - Label row: uppercase mono label on left, "Try an example ↓" button on right (fills textarea with the sample lineup).
    - `<textarea>` 10 rows, `JetBrains Mono 12px/1.6`, `background #121010`, `border 1px solid #3c3833` (focus → accent), padding `16px 18px`, `border-radius 2px`.
    - Placeholder: "One act per line, or paste the raw HTML\nfrom the festival website. We'll figure it out."
  - **Divider** (8px / 24px vertical margin): two 1px rules with `or` centered between them (mono, letter-spacing 0.14em).
  - **URL field**:
    - Label same style as above.
    - `<input>` with `↗` prefix icon (absolute-positioned at left: 18px), padding `14px 18px 14px 40px`, same border / background as textarea.
    - Placeholder: `https://festival.example/lineup`.
  - **Decode button** (margin-top 36px, row):
    - Primary when `hasInput`: accent background (`oklch(0.86 0.18 125)`), dark text, `padding 14px 22px`, mono 11px uppercase letter-spacing 0.16em.
    - Disabled when no input: transparent background, dim border + text.
    - Label: "Decode lineup →". When enabled, a small counter appears next to it: "{n} lines · + 1 url".
  - **Footer strip** (margin-top 80px, `border-top: 1px solid #2a2824`, padding-top 24px): two mono labels on either side — "Works with plain text · HTML · URLs" and "aka / v0.1".

**State.**

- `text: string` — textarea content.
- `url: string` — url field content.
- `hasInput = text.trim() || url.trim()` — enables the Decode button.
- On Decode → parent router switches screen from `"input"` to `"graph"`.

---

### 2. Live resolution / graph screen (`live-columns.jsx`)

**Purpose.** Shows results. Progressive load: nodes appear as pulsing unresolved points → singletons dim as they resolve → cluster edges snap in → multi-evidence edges accrue ticks. The user can click any edge to focus it in the right panel.

**Layout.**

- Full viewport, dark canvas with dotted grid.
- **Top bar** (height 64px, same as input):
  - Left: `←` button (only visible when `onBack` is provided), wordmark, "LINEUP IDENTITY GRAPH" tagline.
  - Center: Resolving indicator — pulsing accent dot + "Resolving…" in mono 11px — disappears when `isDone`.
  - Right: `{nn}%` counter + 140×2px progress bar + `▶ Replay` button (disabled while playing).
- **Graph pane (left, ~64% width)**: `border-right: 1px solid #2a2824`. Contains all the nodes + edges, absolutely positioned.
- **Detail panel (right, ~36% width)**: scrollable column. Two sections stacked with 1px dividers:
  1. **Connection** — mono 10px uppercase eyebrow, then either placeholder text or the `FocusedEdgePanel`.
  2. **No matches** — mono 10px uppercase heading, then the singleton list.

#### Graph — visual rules

- **Background**: `#0a0908` + radial-gradient dotted grid (1px dots, 32px grid, `#2a2824`, opacity 0.35).
- **Nodes**:
  - _Matched_ (cluster members): 7px white dot (`#ece8df`), name at 13px Inter 500, 10px offset from dot.
  - _Singleton, resolved_: 4px dim-gray dot (`#4a4741`), name at 11px Inter 400, color `#7a766e`.
  - _Singleton, unresolved_: 8px accent dot (`oklch(0.86 0.18 125)`) with 8px glow, surrounded by a pulsing 28px halo (keyframe `aka-halo`, 1.4s ease-in-out infinite, opacity 0.18→0.05, scale 1→1.4). Name white.
  - All node state transitions animate over 0.4s.
- **Edges**:
  - Line: `stroke: #3c3833`, `stroke-width: 1`, rounded caps. Focused edge: `stroke: oklch(0.86 0.18 125)`, `stroke-width: 1.5`.
  - **Evidence ticks**: at the midpoint, stack N perpendicular dashes (8px long, 5px apart along the edge axis) — one per evidence item. Filled ticks use `#ece8df` (or accent if focused); unfilled use `#3c3833`.
  - Hit area: invisible 18px-wide line for easier clicking.
- **Cluster positions** are hand-placed in the prototype; the production version should either keep the hand-placed positions for the sample or run a simple force-directed sim.

#### Detail panel — `FocusedEdgePanel`

- **Title**: `{a} ↔ {b}` — Inter 500, 19px, letter-spacing -0.3, with the `↔` in dim gray.
- **Collapsed row** (default): button showing `▶ Connected by N people` (mono 10px uppercase). Arrow rotates 90° when expanded. Count switches to `N/M` when evidence is still loading.
- **Expanded**: list of evidence rows, one per bridge person:
  - Row has `borderTop: 1px solid #2a2824` (except first), padding 7px 0.
  - Left: mono 9px index `01 02 03…` in `#4a4741`.
  - Right:
    - Person name in accent, Inter 500.
    - Below: relation path as `member of → Etnica · member of → Pleiadians` in `#7a766e` mono 10.5px, with `·` separators in `#4a4741` and the group names highlighted in white.
- **Fade-in** animation (`aka-fadein` 0.4s cubic-bezier(.2,.7,.3,1)) when the panel first shows new content.

#### Singleton list

- Label row: "No matches" — mono 10px uppercase.
- List: one row per singleton entry.
  - Mono 9px index in dimmer gray.
  - Small dot (4×4px rounded 2): **resolved** → filled `#4a4741`; **unresolved** → transparent with a 1px dim-gray border.
  - Name: Inter 12px, `#7a766e` when resolved, `#4a4741` when not. Opacity 0.5 when unresolved, transitions over 0.3s.

## Interactions & behavior

### Input screen

- Typing in either field enables the Decode button.
- "Try an example ↓" button fills textarea with the sample (`AKA_DATA.lineup` joined with newlines).
- Decode → transition to graph screen. No parsing in the prototype; wire to the real parser.

### Graph screen — progressive load timeline

The prototype uses a scripted timeline (see the `TIMELINE` array in `live-columns.jsx`). In the real app, drive the same state transitions from backend resolver events:

| Resolver event              | UI effect                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `lineup_parsed` (all names) | All nodes appear pulsing (unresolved singleton look)                                                                                 |
| `entry_resolved_no_match`   | Node for that entry dims to singleton style                                                                                          |
| `edge_discovered(a, b, ev)` | Edge fades in between `a` and `b` with `ev.length` ticks, 1 filled; if this is the first edge discovered, auto-focus it in the panel |
| `evidence_added(edge, ev)`  | Increment filled ticks on that edge; if it's the focused edge, animate a new evidence row in                                         |
| `resolution_complete`       | Stop the resolving indicator, hide status line                                                                                       |

State variables to derive from events:

- `resolvedSingletons: Set<string>`
- `edgesShown: number[]` (indices into the edge list)
- `evidenceCount: Record<edgeIdx, number>`
- `autoSelected: number | null` — last auto-focused edge
- `manualSelect: number | null` — user click; overrides auto-select when set
- `focusedIdx = manualSelect ?? autoSelected`

### Graph screen — user interactions

- **Click edge**: sets `manualSelect` to that index, updating the right panel. Edge turns accent.
- **Click "Connected by N people"** in the detail panel: toggles evidence list expanded/collapsed. Resets to collapsed when switching edges.
- **Click back chevron**: returns to input screen (resets all state).
- **Click Replay**: replays the scripted timeline (in production, replace with a real-refresh action or remove).

## State management

Suggested top-level router state:

```
screen: "input" | "graph"
```

Input screen (local state):

```
text: string
url: string
```

Graph screen (derived from resolver events or a clock):

```
resolvedSingletons: Set<string>
edgesShown: number[]
evidenceCount: Record<number, number>
autoSelected: number | null
manualSelect: number | null
focusedIdx = manualSelect ?? autoSelected
isDone: boolean
progress: 0..1  // only if you keep the progress bar; otherwise derive from resolver completion
```

## Design tokens

### Colors

| Token        | Value                                    | Usage                          |
| ------------ | ---------------------------------------- | ------------------------------ |
| `bg`         | `#0a0908`                                | Page background                |
| `bgSoft`     | `#121010`                                | Input fields, evidence rows    |
| `fg`         | `#ece8df`                                | Primary text                   |
| `fgDim`      | `#7a766e`                                | Secondary text, dim labels     |
| `fgDimmer`   | `#4a4741`                                | Tertiary / disabled            |
| `line`       | `#2a2824`                                | Subtle dividers, grid dots     |
| `lineStrong` | `#3c3833`                                | Input borders, inactive edges  |
| `accent`     | `oklch(0.86 0.18 125)` (acid chartreuse) | Focused edges, CTA, highlights |
| `accentSoft` | `oklch(0.86 0.18 125 / 0.18)`            | Hover glows, halos             |

### Typography

| Family                         | Usage                                   |
| ------------------------------ | --------------------------------------- |
| **Fraunces** 600               | Wordmark, H1 on input screen            |
| **Inter** 400/500/600          | UI body, node names, panel titles       |
| **JetBrains Mono** 400/500/600 | Labels, counters, evidence rows, status |

Google Fonts import:

```
https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&family=Fraunces:opsz,wght@9..144,600&display=swap
```

### Spacing

- Top bar height: **64px**
- Section padding: **32px** horizontal
- Content column max-width: **720px**
- Artboard grid: **32px** dotted grid

### Border radius

- Inputs, cards: **2px** (intentionally square-ish; keep it sharp, not rounded).

### Easing / durations

- UI state changes: **0.12–0.15s ease**
- Node state transitions: **0.4s ease** (halo fade, dim transition)
- Fade-ins: **0.4s cubic-bezier(.2,.7,.3,1)**
- Halo pulse: **1.4s ease-in-out infinite**
- Accent pulse (status dot): **1.2s ease-in-out infinite**

## Assets

No imagery needed. The design uses Google Fonts (Inter, JetBrains Mono, Fraunces) and inline SVG icons only (chevron, play arrow, ↗).

## Files

In this bundle:

- `Live Resolution.html` — entry point; routes between Input and Graph screens.
- `input-screen.jsx` — the input screen component.
- `live-columns.jsx` — the live resolution + graph screen, including `FocusedEdgePanel`, `EvidenceRow`, `GraphNode`, `EdgeShape` subcomponents, and the scripted `TIMELINE`.
- `graph-primitives.jsx` — shared theme tokens (exported as `AKA`), dotted-grid canvas wrapper, and a few helpers.
- `data.js` — the sample lineup + cluster structure. Exports `window.AKA_DATA` (lineup, clusters with nodes + edges + evidence, singletons) and `window.AKA_SUMMARY` — reference these shapes when wiring up the real backend.

## Notes for the implementer

- **Data shape is the contract.** Mirror `AKA_DATA`'s structure in the real backend response:
  ```
  { lineup: string[],
    clusters: [{ id, nodes: string[], edges: [{ a, b, evidence: [{ person, hops: [{ rel, with }] }] }] }],
    singletons: string[] }
  ```
  where `rel` is one of `"alias"`, `"member of"`, `"group of"`.
- **Layout is currently hand-placed.** For arbitrary real-world lineups you'll need a layout strategy — a simple force-directed sim (d3-force) on cluster subgraphs, plus a perimeter ring for singletons, is plenty. Keep singletons visually de-emphasized (smaller dim dots).
- **Edges with many evidence items**: the tick cluster works well up to ~6; past that, switch to a count badge ("7+") to avoid crowding.
- **The "Replay" button is a demo-only affordance.** Remove or repurpose it (e.g., "Refresh") in production.
- **Keep the UI content-light.** Earlier iterations had "N edges between 5 matched entries" headings, an "All edges" list, and a narrating status line — all of that was intentionally cut. The connections and the singleton list are the whole story.
