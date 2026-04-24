// Shared graph primitives: Node (point + name), Edge (line), legend chrome.
// All variations share the same visual vocabulary so the canvas reads
// as one system.

const AKA = {
  bg: '#0a0908',
  bgSoft: '#121010',
  fg: '#ece8df',
  fgDim: '#7a766e',
  fgDimmer: '#4a4741',
  line: '#2a2824',
  lineStrong: '#3c3833',
  accent: 'oklch(0.86 0.18 125)', // acid chartreuse
  accentSoft: 'oklch(0.86 0.18 125 / 0.18)',
  accentDim: 'oklch(0.86 0.18 125 / 0.5)',
  serif: '"Fraunces", Georgia, serif', // used sparingly for the wordmark only
  sans: '-apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif',
  mono: '"JetBrains Mono", "SF Mono", Menlo, monospace',
};

// Injected global CSS for node hover + pulse animations.
if (typeof document !== 'undefined' && !document.getElementById('aka-styles')) {
  const s = document.createElement('style');
  s.id = 'aka-styles';
  s.textContent = `
    .aka-node-dot { transition: transform .18s ease, box-shadow .18s ease; }
    .aka-node:hover .aka-node-dot { transform: scale(1.4); box-shadow: 0 0 0 4px ${AKA.accentSoft}; }
    .aka-node:hover .aka-node-name { color: ${AKA.accent}; }
    .aka-node-name { transition: color .15s ease; }
    .aka-edge { transition: stroke .15s ease, stroke-width .15s ease; }
    .aka-edge-hit:hover + .aka-edge, .aka-edge.is-hovered { stroke: ${AKA.accent}; stroke-width: 1.5; }
    @keyframes aka-pulse { 0%,100% { opacity: .4 } 50% { opacity: 1 } }
    .aka-pulse { animation: aka-pulse 1.4s ease-in-out infinite; }
    @keyframes aka-fadein { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: scale(1); } }
    .aka-fadein { animation: aka-fadein .4s cubic-bezier(.2,.7,.3,1) both; }
    .aka-labelbox { pointer-events: auto; }
    .aka-tick { font-family: ${AKA.mono}; font-size: 9px; letter-spacing: .04em; color: ${AKA.fgDim}; text-transform: uppercase; }
  `;
  document.head.appendChild(s);
}

// A single lineup entry rendered as a point with its name adjacent.
// `dim` flag for singletons. Position is passed from the layout.
function AkaNode({
  x,
  y,
  name,
  dim,
  align = 'right',
  nameOffset = 10,
  dotSize = 6,
  accent = false,
}) {
  const nameStyle = {
    position: 'absolute',
    left: align === 'right' ? nameOffset : 'auto',
    right: align === 'left' ? nameOffset : 'auto',
    top: '50%',
    transform: 'translateY(-50%)',
    whiteSpace: 'nowrap',
    fontFamily: AKA.sans,
    fontSize: dim ? 11 : 13,
    fontWeight: dim ? 400 : 500,
    letterSpacing: dim ? 0.02 : -0.1,
    color: dim ? AKA.fgDim : AKA.fg,
    pointerEvents: 'none',
  };
  const centered = align === 'center';
  return (
    <div
      className="aka-node"
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: 0,
        height: 0,
        zIndex: 3,
      }}
    >
      <div
        className="aka-node-dot"
        style={{
          position: 'absolute',
          left: -dotSize / 2,
          top: -dotSize / 2,
          width: dotSize,
          height: dotSize,
          borderRadius: '50%',
          background: dim ? AKA.fgDimmer : accent ? AKA.accent : AKA.fg,
          boxShadow: accent ? `0 0 12px ${AKA.accentSoft}` : 'none',
        }}
      />
      {centered ? (
        <div
          className="aka-node-name"
          style={{
            ...nameStyle,
            left: '50%',
            top: nameOffset,
            transform: 'translateX(-50%)',
          }}
        >
          {name}
        </div>
      ) : (
        <div className="aka-node-name" style={nameStyle}>
          {name}
        </div>
      )}
    </div>
  );
}

// Straight edge drawn as an SVG line. Returns the midpoint for label placement.
function AkaEdgeLine({ x1, y1, x2, y2, accent = false, dashed = false, strokeWidth = 1 }) {
  return (
    <line
      className="aka-edge"
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={accent ? AKA.accent : AKA.lineStrong}
      strokeWidth={strokeWidth}
      strokeDasharray={dashed ? '2 3' : 'none'}
      strokeLinecap="round"
    />
  );
}

// Artboard header used inside each artboard.
function AkaHeader({ eyebrow, title, subtitle }) {
  return (
    <div style={{ position: 'absolute', top: 24, left: 28, zIndex: 10, pointerEvents: 'none' }}>
      <div
        style={{
          fontFamily: AKA.mono,
          fontSize: 10,
          letterSpacing: '0.12em',
          color: AKA.accent,
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          fontFamily: AKA.sans,
          fontSize: 22,
          fontWeight: 600,
          color: AKA.fg,
          letterSpacing: -0.4,
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontFamily: AKA.mono,
          fontSize: 11,
          color: AKA.fgDim,
          maxWidth: 380,
          lineHeight: 1.5,
        }}
      >
        {subtitle}
      </div>
    </div>
  );
}

// Footer strip inside artboard with counts.
function AkaFooter({ clusterCount, edgeCount, singletonCount, note }) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 20,
        left: 28,
        right: 28,
        zIndex: 10,
        display: 'flex',
        alignItems: 'baseline',
        gap: 24,
        fontFamily: AKA.mono,
        fontSize: 10,
        letterSpacing: '0.04em',
        color: AKA.fgDim,
        textTransform: 'uppercase',
        pointerEvents: 'none',
      }}
    >
      <span>
        <span style={{ color: AKA.fg }}>{clusterCount}</span> clusters
      </span>
      <span>
        <span style={{ color: AKA.fg }}>{edgeCount}</span> edges
      </span>
      <span>
        <span style={{ color: AKA.fg }}>{singletonCount}</span> singletons
      </span>
      {note && (
        <span
          style={{ marginLeft: 'auto', color: AKA.fgDim, textTransform: 'none', letterSpacing: 0 }}
        >
          {note}
        </span>
      )}
    </div>
  );
}

// Canvas shell — handles the near-black bg + subtle noise/grid for each artboard.
function AkaCanvas({ children, style }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: AKA.bg,
        position: 'relative',
        overflow: 'hidden',
        fontFamily: AKA.sans,
        color: AKA.fg,
        ...style,
      }}
    >
      {/* subtle dotted grid */}
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
      {children}
    </div>
  );
}

Object.assign(window, { AKA, AkaNode, AkaEdgeLine, AkaHeader, AkaFooter, AkaCanvas });
