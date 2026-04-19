// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { cleanHTML } from '../src/core/cleanHTML.js';

describe('cleanHTML', () => {
  it('drops scripts, styles, and other noise elements', () => {
    const html = `
      <html><head><title>x</title></head><body>
        <script>evil()</script>
        <style>.a{color:red}</style>
        <noscript>nope</noscript>
        <svg><circle/></svg>
        <iframe src="x"></iframe>
        <p>keep me</p>
      </body></html>
    `;
    const out = cleanHTML(html);
    expect(out).not.toMatch(/evil/);
    expect(out).not.toMatch(/color:red/);
    expect(out).not.toMatch(/nope/);
    expect(out).not.toMatch(/<svg/);
    expect(out).not.toMatch(/<iframe/);
    expect(out).toMatch(/keep me/);
  });

  it('drops navigation, header, footer, aside, form elements', () => {
    const html = `
      <body>
        <nav><a>Home</a></nav>
        <header><h1>Site name</h1></header>
        <aside>newsletter signup</aside>
        <form><button>Subscribe</button></form>
        <main><p>Aphex Twin</p></main>
        <footer>copyright</footer>
      </body>
    `;
    const out = cleanHTML(html);
    expect(out).not.toMatch(/Home/);
    expect(out).not.toMatch(/Site name/);
    expect(out).not.toMatch(/newsletter/);
    expect(out).not.toMatch(/Subscribe/);
    expect(out).not.toMatch(/copyright/);
    expect(out).toMatch(/Aphex Twin/);
  });

  it('strips all attributes', () => {
    const html = `<body><div class="x" id="y" data-foo="bar" style="color:red"><a href="/z" target="_blank">hi</a></div></body>`;
    const out = cleanHTML(html);
    expect(out).not.toMatch(/class=/);
    expect(out).not.toMatch(/data-foo/);
    expect(out).not.toMatch(/style=/);
    expect(out).not.toMatch(/href=/);
    expect(out).not.toMatch(/target=/);
    expect(out).toMatch(/<a>hi<\/a>/);
  });

  it('strips HTML comments', () => {
    const html = `<body><!-- tracking pixel --><p>keep</p><!--[if IE]>old<![endif]--></body>`;
    const out = cleanHTML(html);
    expect(out).not.toMatch(/tracking/);
    expect(out).not.toMatch(/old/);
    expect(out).toMatch(/keep/);
  });

  it('collapses whitespace aggressively', () => {
    const html = `<body>
      <p>   lots    of    space
           across    lines   </p>
    </body>`;
    const out = cleanHTML(html);
    expect(out).not.toMatch(/  /);
    expect(out).not.toMatch(/\n/);
  });

  it('returns empty string on empty / null / undefined input', () => {
    expect(cleanHTML('')).toBe('');
    expect(cleanHTML(null)).toBe('');
    expect(cleanHTML(undefined)).toBe('');
  });

  it('meaningfully shrinks a realistic festival lineup page', () => {
    const html = `
      <html>
        <head>
          <title>Boomfest 2026</title>
          <meta name="description" content="the best">
          <link rel="stylesheet" href="/site.css">
          <script src="/analytics.js"></script>
        </head>
        <body class="page-home" data-theme="dark">
          <nav class="nav-bar"><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav>
          <header><h1 class="title">Boomfest 2026</h1></header>
          <main>
            <section class="lineup">
              <h2>Lineup</h2>
              <ul>
                <li class="artist">Aphex Twin</li>
                <li class="artist">Infected Mushroom</li>
                <li class="artist">Shpongle</li>
              </ul>
            </section>
          </main>
          <aside class="sidebar"><form><input type="email"/><button>Subscribe</button></form></aside>
          <footer>&copy; 2026</footer>
        </body>
      </html>
    `;
    const out = cleanHTML(html);
    expect(out.length).toBeLessThan(html.length / 2);
    expect(out).toMatch(/Aphex Twin/);
    expect(out).toMatch(/Infected Mushroom/);
    expect(out).toMatch(/Shpongle/);
    expect(out).not.toMatch(/analytics/);
    expect(out).not.toMatch(/Subscribe/);
    expect(out).not.toMatch(/About/);
  });
});
