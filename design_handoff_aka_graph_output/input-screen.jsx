// Input screen — step 1 of the user journey.
// Two fields: paste lineup (text or HTML), paste URL.
// "Decode lineup" button transitions to the graph view.
// Purely visual — no parsing actually happens.

function InputScreen({ onDecode }) {
  const [text, setText] = React.useState('');
  const [url, setUrl] = React.useState('');

  const EXAMPLE = [
    'Atmos',
    'Battle of the Future Buddhas',
    'Blue Planet Corporation',
    'Doof',
    'Eat Static',
    'Growling Mad Scientists',
    'Filteria',
    'Ultravibe',
    '1200mic',
    'Bumbling Loons',
    'Dickster',
    'Etnica',
    'Green Nuns of the Revolution',
    'Pleiadians',
  ].join('\n');

  const hasInput = text.trim().length > 0 || url.trim().length > 0;

  const useExample = () => {
    setText(EXAMPLE);
    setUrl('');
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: AKA.bg,
        color: AKA.fg,
        fontFamily: AKA.sans,
        overflow: 'auto',
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

      {/* Top bar — just the wordmark */}
      <header
        style={{
          position: 'relative',
          height: 64,
          display: 'flex',
          alignItems: 'center',
          padding: '0 32px',
          borderBottom: `1px solid ${AKA.line}`,
          zIndex: 5,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
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
      </header>

      {/* Main body */}
      <main
        style={{
          position: 'relative',
          maxWidth: 720,
          margin: '0 auto',
          padding: '80px 32px 64px',
          zIndex: 5,
        }}
      >
        {/* Hero */}
        <div style={{ marginBottom: 56 }}>
          <div
            style={{
              fontFamily: AKA.mono,
              fontSize: 10,
              letterSpacing: '0.18em',
              color: AKA.accent,
              textTransform: 'uppercase',
              marginBottom: 18,
            }}
          >
            <span style={{ marginRight: 12 }}>01</span>
            <span>Drop in a lineup</span>
          </div>
          <h1
            style={{
              fontFamily: AKA.serif,
              fontSize: 52,
              fontWeight: 600,
              letterSpacing: -1.2,
              lineHeight: 1.05,
              color: AKA.fg,
              margin: '0 0 18px',
            }}
          >
            Who's actually
            <br />
            on the bill?
          </h1>
          <p
            style={{
              fontFamily: AKA.sans,
              fontSize: 16,
              lineHeight: 1.55,
              color: AKA.fgDim,
              margin: 0,
              maxWidth: 520,
            }}
          >
            Paste a festival lineup or link one from the web.
            <span style={{ color: AKA.fg }}> aka </span>
            finds the other names each act performs under — the side projects, the aliases, the
            shared members.
          </p>
        </div>

        {/* Field: paste */}
        <label style={{ display: 'block', marginBottom: 28 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              marginBottom: 10,
            }}
          >
            <span
              style={{
                fontFamily: AKA.mono,
                fontSize: 10,
                letterSpacing: '0.14em',
                color: AKA.fgDim,
                textTransform: 'uppercase',
              }}
            >
              Paste lineup
            </span>
            <button
              onClick={useExample}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                fontFamily: AKA.mono,
                fontSize: 10,
                letterSpacing: '0.12em',
                color: AKA.fgDim,
                textTransform: 'uppercase',
                transition: 'color .12s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = AKA.accent;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = AKA.fgDim;
              }}
            >
              Try an example ↓
            </button>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "One act per line, or paste the raw HTML\nfrom the festival website. We'll figure it out."
            }
            rows={10}
            style={{
              display: 'block',
              width: '100%',
              boxSizing: 'border-box',
              padding: '16px 18px',
              background: AKA.bgSoft,
              color: AKA.fg,
              border: `1px solid ${AKA.lineStrong}`,
              borderRadius: 2,
              outline: 'none',
              fontFamily: AKA.mono,
              fontSize: 12,
              lineHeight: 1.6,
              resize: 'vertical',
              transition: 'border-color .12s ease',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = AKA.accent;
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = AKA.lineStrong;
            }}
          />
        </label>

        {/* Divider with "or" */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            margin: '8px 0 24px',
          }}
        >
          <div style={{ flex: 1, height: 1, background: AKA.line }} />
          <span
            style={{
              fontFamily: AKA.mono,
              fontSize: 10,
              letterSpacing: '0.14em',
              color: AKA.fgDimmer,
              textTransform: 'uppercase',
            }}
          >
            or
          </span>
          <div style={{ flex: 1, height: 1, background: AKA.line }} />
        </div>

        {/* Field: URL */}
        <label style={{ display: 'block', marginBottom: 36 }}>
          <div style={{ marginBottom: 10 }}>
            <span
              style={{
                fontFamily: AKA.mono,
                fontSize: 10,
                letterSpacing: '0.14em',
                color: AKA.fgDim,
                textTransform: 'uppercase',
              }}
            >
              Link to a lineup
            </span>
          </div>
          <div style={{ position: 'relative' }}>
            <span
              style={{
                position: 'absolute',
                left: 18,
                top: '50%',
                transform: 'translateY(-50%)',
                fontFamily: AKA.mono,
                fontSize: 12,
                color: AKA.fgDimmer,
                pointerEvents: 'none',
              }}
            >
              ↗
            </span>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://festival.example/lineup"
              style={{
                display: 'block',
                width: '100%',
                boxSizing: 'border-box',
                padding: '14px 18px 14px 40px',
                background: AKA.bgSoft,
                color: AKA.fg,
                border: `1px solid ${AKA.lineStrong}`,
                borderRadius: 2,
                outline: 'none',
                fontFamily: AKA.mono,
                fontSize: 12,
                transition: 'border-color .12s ease',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = AKA.accent;
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = AKA.lineStrong;
              }}
            />
          </div>
        </label>

        {/* Decode button */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <button
            onClick={() => onDecode()}
            disabled={!hasInput}
            style={{
              padding: '14px 22px',
              background: hasInput ? AKA.accent : 'transparent',
              border: `1px solid ${hasInput ? AKA.accent : AKA.lineStrong}`,
              color: hasInput ? AKA.bg : AKA.fgDimmer,
              fontFamily: AKA.mono,
              fontSize: 11,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              fontWeight: 600,
              cursor: hasInput ? 'pointer' : 'default',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              transition: 'all .15s ease',
            }}
          >
            <span>Decode lineup</span>
            <span style={{ opacity: 0.7 }}>→</span>
          </button>
          {hasInput && (
            <span
              style={{
                fontFamily: AKA.mono,
                fontSize: 10,
                letterSpacing: '0.1em',
                color: AKA.fgDim,
              }}
            >
              {text.trim().split(/\n+/).filter(Boolean).length} line
              {text.trim().split(/\n+/).filter(Boolean).length === 1 ? '' : 's'}
              {url.trim() && text.trim() && ' · '}
              {url.trim() && '+ 1 url'}
            </span>
          )}
        </div>

        {/* Footer tick */}
        <div
          style={{
            marginTop: 80,
            paddingTop: 24,
            borderTop: `1px solid ${AKA.line}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontFamily: AKA.mono,
            fontSize: 10,
            letterSpacing: '0.14em',
            color: AKA.fgDimmer,
            textTransform: 'uppercase',
          }}
        >
          <span>Works with plain text · HTML · URLs</span>
          <span>aka / v0.1</span>
        </div>
      </main>
    </div>
  );
}

window.InputScreen = InputScreen;
