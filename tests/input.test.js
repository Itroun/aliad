// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createInputScreen, parseLineup } from '../src/ui/inputScreen.js';

describe('parseLineup', () => {
  it('splits on newlines, trims, and dedupes case-insensitively', () => {
    const text = '  Infected Mushroom\nShpongle\n\ninfected mushroom\n   \nAphex Twin\n';
    expect(parseLineup(text)).toEqual(['Infected Mushroom', 'Shpongle', 'Aphex Twin']);
  });

  it('collapses punctuation/spacing variants of one act to a single entry', () => {
    // Reader-mode extractions often list the same act several ways; these are
    // one identity and must dedupe to the first spelling seen.
    const text = 'Ree K\nRee.K\nRee-K\nDOMINO vs Ree-K';
    expect(parseLineup(text)).toEqual(['Ree K', 'DOMINO vs Ree-K']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseLineup('')).toEqual([]);
    expect(parseLineup('   \n\n  ')).toEqual([]);
  });
});

describe('createInputScreen', () => {
  let root;
  beforeEach(() => {
    document.body.innerHTML = '';
    root = null;
  });

  function mount(handlers = {}) {
    const screen = createInputScreen(handlers);
    document.body.append(screen.el);
    root = screen.el;
    return root;
  }

  const setText = (value) => {
    const ta = root.querySelector('.lineup-input');
    ta.value = value;
    ta.dispatchEvent(new Event('input'));
    return ta;
  };

  it('starts with the Map button disabled and no readout', () => {
    mount();
    expect(root.querySelector('.decode-btn').disabled).toBe(true);
    expect(root.querySelector('.field-readout').hidden).toBe(true);
  });

  it('enables Map and reads out act count when text is entered', () => {
    mount();
    setText('Foo\nBar');
    expect(root.querySelector('.decode-btn').disabled).toBe(false);
    expect(root.querySelector('.field-readout').hidden).toBe(false);
    expect(root.querySelector('.readout-text').textContent).toContain('2 acts');
  });

  it('reads out link count when only URLs are entered', () => {
    mount();
    setText('https://example.com/lineup');
    expect(root.querySelector('.decode-btn').disabled).toBe(false);
    expect(root.querySelector('.readout-text').textContent).toContain('1 link');
  });

  it('reads out a mix of links and acts', () => {
    mount();
    setText('Atmos\nhttps://example.com/lineup\nFilteria');
    const readout = root.querySelector('.readout-text').textContent;
    expect(readout).toContain('1 link + 2 acts');
    // The mixed case explains that the fetched lineup merges with the pasted acts.
    expect(readout).toContain('merged with the pasted act');
  });

  it('"Try an example" fills the textarea and enables Map', () => {
    mount();
    root.querySelector('.example-btn').click();
    const ta = root.querySelector('.lineup-input');
    expect(ta.value.length).toBeGreaterThan(10);
    expect(root.querySelector('.decode-btn').disabled).toBe(false);
  });

  it('submits a text-only payload on Map click', () => {
    const received = [];
    mount({ onSubmit: (p) => received.push(p) });
    setText('A\nB');
    root.querySelector('.decode-btn').click();
    expect(received).toEqual([{ urls: [], text: 'A\nB', html: null, pasteFormat: null }]);
  });

  it('submits a URL-only payload, dropping the dead html', () => {
    const received = [];
    mount({ onSubmit: (p) => received.push(p) });
    setText('https://example.com/lineup');
    root.querySelector('.decode-btn').click();
    expect(received).toEqual([
      { urls: ['https://example.com/lineup'], text: '', html: null, pasteFormat: null },
    ]);
  });

  it('submits both links and text from one field, deduping URLs', () => {
    const received = [];
    mount({ onSubmit: (p) => received.push(p) });
    setText('Atmos\nhttps://fest.example/a\nFilteria\nhttps://fest.example/a');
    root.querySelector('.decode-btn').click();
    expect(received).toEqual([
      { urls: ['https://fest.example/a'], text: 'Atmos\nFilteria', html: null, pasteFormat: null },
    ]);
  });

  it('caps the submitted URLs at 10', () => {
    const received = [];
    mount({ onSubmit: (p) => received.push(p) });
    const lines = Array.from({ length: 15 }, (_, i) => `https://fest.example/${i}`);
    setText(lines.join('\n'));
    expect(root.querySelector('.readout-text').textContent).toContain('10 links');
    root.querySelector('.decode-btn').click();
    expect(received[0].urls).toHaveLength(10);
  });
});
