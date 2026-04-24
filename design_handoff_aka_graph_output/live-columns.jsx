// Variation 4 + Live resolution — full-bleed standalone prototype.
// Combines the Columns layout (graph left, detail + singleton index right)
// with a scripted progressive-load timeline and a replay button.

function LiveColumnsApp({ onBack }) {
  const data = window.AKA_DATA;
  const summary = window.AKA_SUMMARY;

  // Size: fill the viewport, with generous padding around the graph.
  const [vp, setVp] = React.useState({ w: window.innerWidth, h: window.innerHeight });
  React.useEffect(() => {
    const r = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);

  const leftW = Math.max(520, vp.w * 0.64);
  const rightW = vp.w - leftW;
  const H = vp.h;

  // ─── Timeline ────────────────────────────────────────────────────────
  // Sequenced events. All lineup nodes appear, then resolution proceeds:
  // singletons dim first, cluster edges form one by one, multi-evidence
  // edges accrete extra ticks.
  const TIMELINE = React.useMemo(
    () => [
      { t: 0, ev: 'lineup' }, // all nodes appear, pulsing
      { t: 350, ev: 'status', text: 'Searching for aliases across 14 entries' },
      { t: 700, ev: 'resolve-singleton', name: 'Atmos' },
      { t: 900, ev: 'resolve-singleton', name: 'Doof' },
      { t: 1100, ev: 'resolve-singleton', name: 'Eat Static' },
      { t: 1300, ev: 'resolve-singleton', name: 'Filteria' },
      { t: 1500, ev: 'resolve-singleton', name: 'Battle of the Future Buddhas' },
      { t: 1700, ev: 'resolve-singleton', name: 'Blue Planet Corporation' },
      { t: 1900, ev: 'resolve-singleton', name: 'Growling Mad Scientists' },
      { t: 2100, ev: 'resolve-singleton', name: 'Ultravibe' },
      { t: 2300, ev: 'resolve-singleton', name: '1200mic' },
      { t: 2500, ev: 'status', text: 'Cross-referencing members…' },
      { t: 2800, ev: 'edge', idx: 0, select: true }, // Dickster ↔ Bumbling Loons
      { t: 3300, ev: 'edge', idx: 1, select: true }, // Dickster ↔ Green Nuns (triangle forming)
      { t: 3700, ev: 'edge', idx: 2, select: true }, // Bumbling Loons ↔ Green Nuns (triangle closed)
      { t: 4100, ev: 'edge', idx: 3, select: true }, // Etnica ↔ Pleiadians (1/4)
      { t: 4400, ev: 'evidence', idx: 3, count: 2 },
      { t: 4700, ev: 'evidence', idx: 3, count: 3 },
      { t: 5000, ev: 'evidence', idx: 3, count: 4 },
      { t: 5300, ev: 'status', text: 'Done · 2 clusters, 4 edges, 9 singletons' },
      { t: 5500, ev: 'done' },
    ],
    [],
  );

  const DURATION = TIMELINE[TIMELINE.length - 1].t;
  const [clock, setClock] = React.useState(DURATION);
  const [playing, setPlaying] = React.useState(false);
  const [manualSelect, setManualSelect] = React.useState(null);
  const startRef = React.useRef(0);
  const rafRef = React.useRef(0);

  const replay = React.useCallback(() => {
    setManualSelect(null);
    setPlaying(true);
    setClock(0);
    startRef.current = performance.now();
  }, []);

  React.useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const elapsed = performance.now() - startRef.current;
      if (elapsed >= DURATION) {
        setClock(DURATION);
        setPlaying(false);
        return;
      }
      setClock(elapsed);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, DURATION]);

  // Auto-play on first mount
  React.useEffect(() => {
    const t = setTimeout(replay, 500);
    return () => clearTimeout(t);
  }, [replay]);

  // Derive world state from the clock.
  const state = React.useMemo(() => {
    let lineup = false;
    const resolvedSingletons = new Set();
    const edgesShown = [];
    const evidenceCount = { 0: 1, 1: 1, 2: 1, 3: 1 };
    let autoSelected = null;
    let status = 'Pasting lineup…';

    for (const e of TIMELINE) {
      if (e.t > clock) break;
      if (e.ev === 'lineup') {
        lineup = true;
      }
      if (e.ev === 'status') {
        status = e.text;
      }
      if (e.ev === 'resolve-singleton') {
        resolvedSingletons.add(e.name);
      }
      if (e.ev === 'edge') {
        edgesShown.push(e.idx);
        if (e.select) autoSelected = e.idx;
      }
      if (e.ev === 'evidence') {
        evidenceCount[e.idx] = e.count;
        if (e.idx === autoSelected) autoSelected = e.idx; // keep
      }
    }
    return { lineup, resolvedSingletons, edgesShown, evidenceCount, autoSelected, status };
  }, [clock, TIMELINE]);

  // ─── Layout ──────────────────────────────────────────────────────────
  const layout = React.useMemo(() => {
    const positions = {};
    const headerOffset = 110;

    // Cluster 1 — triangle in upper half of graph region
    const c1cx = leftW * 0.45,
      c1cy = headerOffset + (H - headerOffset) * 0.28;
    positions['Dickster'] = { x: c1cx - 150, y: c1cy - 20 };
    positions['Bumbling Loons'] = { x: c1cx + 55, y: c1cy - 110 };
    positions['Green Nuns of the Revolution'] = { x: c1cx + 140, y: c1cy + 95 };

    // Cluster 2 — horizontal pair in lower half
    const c2cy = headerOffset + (H - headerOffset) * 0.78;
    positions['Etnica'] = { x: leftW * 0.25, y: c2cy };
    positions['Pleiadians'] = { x: leftW * 0.7, y: c2cy };

    return positions;
  }, [leftW, H]);

  // All edges in timeline order
  const allEdges = React.useMemo(() => {
    const arr = [];
    data.clusters.forEach((c) => c.edges.forEach((e) => arr.push(e)));
    return arr;
  }, [data]);

  // Currently-focused edge in the panel:
  // manual selection wins; otherwise follow the timeline's auto-select.
  const focusedIdx = manualSelect ?? state.autoSelected;
  const focusedEdge = focusedIdx != null ? allEdges[focusedIdx] : null;

  const progress = Math.min(1, clock / DURATION);
  const isDone = progress >= 1;

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: AKA.bg,
        color: AKA.fg,
        fontFamily: AKA.sans,
        overflow: 'hidden',
      }}
    >
      {/* Dotted grid */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `radial-gradient(circle, ${AKA.line} 1px, transparent 1px)`,
          backgroundSize: '32px 32px',
          opacity: 0.35,
          pointerEvents: 'none',
        }}
      />

      {/* TOP BAR */}
      <header
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 64,
          display: 'flex',
          alignItems: 'center',
          padding: '0 32px',
          borderBottom: `1px solid ${AKA.line}`,
          background: `${AKA.bg}e6`,
          backdropFilter: 'blur(6px)',
          zIndex: 50,
        }}
      >
        {/* Wordmark */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          {onBack && (
            <button
              onClick={onBack}
              title="New lineup"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                marginRight: 4,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: AKA.fgDim,
                transition: 'color .12s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = AKA.accent;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = AKA.fgDim;
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M9 2L3 7l6 5" />
              </svg>
            </button>
          )}
          <div
            style={{
              fontFamily: AKA.serif,
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: -0.6,
              color: AKA.fg,
              lineHeight: 1,
            }}
          >
            aka
          </div>
          <div
            style={{
              fontFamily: AKA.mono,
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: AKA.fgDim,
            }}
          >
            lineup identity graph
          </div>
        </div>

        {/* Status line (center) */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          {!isDone && (
            <>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  background: AKA.accent,
                  boxShadow: `0 0 8px ${AKA.accent}`,
                  animation: 'aka-pulse 1.2s ease-in-out infinite',
                }}
              />
              <span
                style={{
                  fontFamily: AKA.mono,
                  fontSize: 11,
                  color: AKA.fgDim,
                  letterSpacing: 0.02,
                }}
              >
                Resolving…
              </span>
            </>
          )}
        </div>

        {/* Progress + replay */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              fontFamily: AKA.mono,
              fontSize: 10,
              color: AKA.fgDim,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {Math.round(progress * 100)
              .toString()
              .padStart(3, '0')}
            %
          </div>
          <div style={{ width: 140, height: 2, background: AKA.line, position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${progress * 100}%`,
                background: AKA.accent,
              }}
            />
          </div>
          <button
            onClick={replay}
            disabled={playing}
            style={{
              padding: '6px 12px',
              background: 'transparent',
              border: `1px solid ${playing ? AKA.line : AKA.fgDim}`,
              color: playing ? AKA.fgDimmer : AKA.fg,
              fontFamily: AKA.mono,
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              cursor: playing ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              transition: 'all .15s ease',
            }}
            onMouseEnter={(e) => {
              if (!playing) {
                e.currentTarget.style.borderColor = AKA.accent;
                e.currentTarget.style.color = AKA.accent;
              }
            }}
            onMouseLeave={(e) => {
              if (!playing) {
                e.currentTarget.style.borderColor = AKA.fgDim;
                e.currentTarget.style.color = AKA.fg;
              }
            }}
          >
            <svg width="8" height="9" viewBox="0 0 9 10" fill="currentColor">
              <path d="M0 0l9 5-9 5z" />
            </svg>
            Replay
          </button>
        </div>
      </header>

      {/* ────── LEFT: GRAPH ────── */}
      <section
        style={{
          position: 'absolute',
          top: 64,
          left: 0,
          width: leftW,
          height: H - 64,
          borderRight: `1px solid ${AKA.line}`,
        }}
      >
        {/* Edges (SVG) */}
        <svg style={{ position: 'absolute', inset: 0 }} width={leftW} height={H - 64}>
          {allEdges.map((e, i) => {
            if (!state.edgesShown.includes(i)) return null;
            const pa = layout[e.a],
              pb = layout[e.b];
            if (!pa || !pb) return null;
            const shownEv = state.evidenceCount[i] ?? 1;
            const totalEv = e.evidence.length;
            const isFocused = focusedIdx === i;
            return (
              <EdgeShape
                key={i}
                pa={pa}
                pb={pb}
                shownEv={shownEv}
                totalEv={totalEv}
                focused={isFocused}
                onClick={() => setManualSelect(i)}
              />
            );
          })}
        </svg>

        {/* Nodes */}
        {state.lineup &&
          Object.entries(layout).map(([name, pos]) => {
            const isSingleton = data.singletons.includes(name);
            // For cluster members, they stay bright. Singletons transition from
            // pulsing accent → dim gray when resolved.
            const isResolvedSingleton = isSingleton && state.resolvedSingletons.has(name);
            const isUnresolved = isSingleton && !isResolvedSingleton;

            return (
              <GraphNode
                key={name}
                x={pos.x}
                y={pos.y}
                name={name}
                dim={isResolvedSingleton}
                unresolved={isUnresolved}
                align={pos.x > leftW * 0.55 ? 'left' : 'right'}
              />
            );
          })}
      </section>

      {/* ────── RIGHT: PANEL ────── */}
      <aside
        style={{
          position: 'absolute',
          top: 64,
          right: 0,
          width: rightW,
          height: H - 64,
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
        }}
      >
        {/* Edge detail card */}
        <div
          style={{
            padding: '32px 32px 24px',
            borderBottom: `1px solid ${AKA.line}`,
            flex: '0 0 auto',
          }}
        >
          <div
            style={{
              fontFamily: AKA.mono,
              fontSize: 10,
              letterSpacing: '0.14em',
              color: AKA.fgDim,
              textTransform: 'uppercase',
              marginBottom: 14,
            }}
          >
            Connection
          </div>

          {!focusedEdge ? (
            <div
              style={{
                fontFamily: AKA.mono,
                fontSize: 11,
                color: AKA.fgDim,
                lineHeight: 1.6,
                letterSpacing: '0.04em',
              }}
            >
              Click a connection to see who links them.
            </div>
          ) : (
            <FocusedEdgePanel
              edge={focusedEdge}
              shownCount={state.evidenceCount[focusedIdx] ?? focusedEdge.evidence.length}
              summary={summary}
            />
          )}
        </div>

        {/* Singleton index */}
        <div style={{ padding: '20px 32px', flex: '0 0 auto' }}>
          <div
            style={{
              fontFamily: AKA.mono,
              fontSize: 9,
              letterSpacing: '0.14em',
              color: AKA.fgDim,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            No matches
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {data.singletons.map((name, i) => {
              const resolved = state.resolvedSingletons.has(name);
              return (
                <div
                  key={name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    fontFamily: AKA.sans,
                    fontSize: 12,
                    color: resolved ? AKA.fgDim : AKA.fgDimmer,
                    padding: '3px 0',
                    opacity: resolved ? 1 : 0.5,
                    transition: 'opacity .3s ease, color .3s ease',
                  }}
                >
                  <span
                    style={{
                      fontFamily: AKA.mono,
                      fontSize: 9,
                      color: AKA.fgDimmer,
                      minWidth: 20,
                    }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: 2,
                      background: resolved ? AKA.fgDimmer : 'transparent',
                      border: resolved ? 'none' : `1px solid ${AKA.fgDimmer}`,
                      flexShrink: 0,
                      transition: 'background .3s ease',
                    }}
                  />
                  <span>{name}</span>
                </div>
              );
            })}
          </div>
        </div>
      </aside>
    </div>
  );
}

// ─── Focused edge panel — collapsible evidence ─────────────────────
function FocusedEdgePanel({ edge, shownCount, summary }) {
  const [expanded, setExpanded] = React.useState(false);
  const evCount = edge.evidence.length;
  // Reset collapsed state when switching edges
  React.useEffect(() => {
    setExpanded(false);
  }, [edge.a, edge.b]);

  return (
    <>
      <div
        style={{
          fontFamily: AKA.sans,
          fontSize: 19,
          fontWeight: 500,
          letterSpacing: -0.3,
          color: AKA.fg,
          marginBottom: 18,
          lineHeight: 1.3,
        }}
      >
        {edge.a}
        <span style={{ color: AKA.fgDim, margin: '0 8px', fontWeight: 400 }}>↔</span>
        {edge.b}
      </div>

      <button
        onClick={() => setExpanded((x) => !x)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          margin: '0 -10px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: AKA.mono,
          fontSize: 10,
          letterSpacing: '0.12em',
          color: AKA.fgDim,
          textTransform: 'uppercase',
          transition: 'color .12s ease',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = AKA.fg;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = AKA.fgDim;
        }}
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="currentColor"
          style={{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform .15s ease',
          }}
        >
          <path d="M1 0l6 4-6 4z" />
        </svg>
        <span>
          Connected by {shownCount}
          {shownCount < evCount ? `/${evCount}` : ''} {evCount === 1 ? 'person' : 'people'}
        </span>
      </button>

      {expanded && (
        <div className="aka-fadein" style={{ marginTop: 10 }}>
          {edge.evidence.slice(0, shownCount).map((ev, j) => (
            <EvidenceRow key={j} ev={ev} a={edge.a} b={edge.b} idx={j} summary={summary} />
          ))}
        </div>
      )}
    </>
  );
}

// ─── Node ────────────────────────────────────────────────────────────
function GraphNode({ x, y, name, dim, unresolved, align }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: 0,
        height: 0,
        zIndex: 3,
      }}
    >
      {/* Pulse halo for unresolved */}
      {unresolved && (
        <div
          style={{
            position: 'absolute',
            left: -14,
            top: -14,
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: AKA.accent,
            opacity: 0.18,
            animation: 'aka-halo 1.4s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />
      )}
      {/* Dot */}
      <div
        style={{
          position: 'absolute',
          left: unresolved ? -4 : dim ? -2 : -3.5,
          top: unresolved ? -4 : dim ? -2 : -3.5,
          width: unresolved ? 8 : dim ? 4 : 7,
          height: unresolved ? 8 : dim ? 4 : 7,
          borderRadius: '50%',
          background: unresolved ? AKA.accent : dim ? AKA.fgDimmer : AKA.fg,
          boxShadow: unresolved ? `0 0 8px ${AKA.accent}` : 'none',
          transition: 'all .4s ease',
        }}
      />
      {/* Name */}
      <div
        style={{
          position: 'absolute',
          left: align === 'right' ? 12 : 'auto',
          right: align === 'left' ? 12 : 'auto',
          top: '50%',
          transform: 'translateY(-50%)',
          whiteSpace: 'nowrap',
          fontFamily: AKA.sans,
          fontSize: dim ? 11 : 13,
          fontWeight: dim ? 400 : 500,
          letterSpacing: dim ? 0 : -0.1,
          color: unresolved ? AKA.fg : dim ? AKA.fgDim : AKA.fg,
          pointerEvents: 'none',
          transition: 'color .4s ease, font-size .4s ease',
        }}
      >
        {name}
      </div>
    </div>
  );
}

// ─── Edge ────────────────────────────────────────────────────────────
// Edge line + a small evidence-count badge at the midpoint. Badge ticks
// animate in as evidence accrues.
function EdgeShape({ pa, pb, shownEv, totalEv, focused, onClick }) {
  const mx = (pa.x + pb.x) / 2,
    my = (pa.y + pb.y) / 2;
  const dx = pb.x - pa.x,
    dy = pb.y - pa.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len,
    uy = dy / len;
  // perpendicular
  const px = -uy,
    py = ux;

  // Evidence ticks: n small perpendicular dashes at the midpoint
  const tickSpacing = 5;
  const ticks = [];
  for (let i = 0; i < totalEv; i++) {
    const offset = (i - (totalEv - 1) / 2) * tickSpacing;
    const cx = mx + ux * offset;
    const cy = my + uy * offset;
    const isFilled = i < shownEv;
    ticks.push(
      <line
        key={i}
        x1={cx + px * 4}
        y1={cy + py * 4}
        x2={cx - px * 4}
        y2={cy - py * 4}
        stroke={isFilled ? (focused ? AKA.accent : AKA.fg) : AKA.lineStrong}
        strokeWidth="1.5"
        strokeLinecap="round"
        style={{ transition: 'stroke .3s ease' }}
      />,
    );
  }

  return (
    <g onClick={onClick} style={{ cursor: 'pointer' }}>
      {/* Hit area */}
      <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke="transparent" strokeWidth="18" />
      {/* Visible line */}
      <line
        x1={pa.x}
        y1={pa.y}
        x2={pb.x}
        y2={pb.y}
        stroke={focused ? AKA.accent : AKA.lineStrong}
        strokeWidth={focused ? 1.5 : 1}
        strokeLinecap="round"
        style={{ transition: 'stroke .2s ease, stroke-width .2s ease' }}
      />
      {/* Evidence tick cluster at midpoint */}
      {ticks}
    </g>
  );
}

// ─── Evidence row ────────────────────────────────────────────────────
function EvidenceRow({ ev, a, b, idx, summary }) {
  return (
    <div
      className="aka-fadein"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '7px 0',
        borderTop: idx === 0 ? 'none' : `1px solid ${AKA.line}`,
        fontFamily: AKA.mono,
        fontSize: 11,
        lineHeight: 1.5,
        color: AKA.fg,
      }}
    >
      <span
        style={{
          fontFamily: AKA.mono,
          fontSize: 9,
          color: AKA.fgDimmer,
          paddingTop: 2,
          minWidth: 18,
          letterSpacing: '0.05em',
        }}
      >
        {String(idx + 1).padStart(2, '0')}
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ color: AKA.accent, fontWeight: 500, marginBottom: 2 }}>{ev.person}</div>
        <div style={{ color: AKA.fgDim, fontSize: 10.5 }}>
          {ev.hops.map((h, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ margin: '0 4px', color: AKA.fgDimmer }}>·</span>}
              <span>{h.rel}</span>
              <span style={{ margin: '0 4px', color: AKA.fgDimmer }}>→</span>
              <span style={{ color: AKA.fg }}>{h.with}</span>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

// Halo keyframes + fadein
if (typeof document !== 'undefined' && !document.getElementById('aka-live-styles')) {
  const s = document.createElement('style');
  s.id = 'aka-live-styles';
  s.textContent = `
    @keyframes aka-halo {
      0%,100% { transform: scale(1); opacity: .18; }
      50% { transform: scale(1.4); opacity: .05; }
    }
  `;
  document.head.appendChild(s);
}

window.LiveColumnsApp = LiveColumnsApp;
