// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createInputScreen, parseLineup } from '../src/ui/inputScreen.js';

describe('parseLineup', () => {
  it('splits on newlines, trims, and dedupes case-insensitively', () => {
    const text = '  Infected Mushroom\nShpongle\n\ninfected mushroom\n   \nAphex Twin\n';
    expect(parseLineup(text)).toEqual(['Infected Mushroom', 'Shpongle', 'Aphex Twin']);
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

  it('starts with the Decode button disabled', () => {
    mount();
    expect(root.querySelector('.decode-btn').disabled).toBe(true);
    expect(root.querySelector('.decode-counter').textContent).toBe('');
  });

  it('enables Decode and shows a counter when text is entered', () => {
    mount();
    const ta = root.querySelector('.lineup-input');
    ta.value = 'Foo\nBar';
    ta.dispatchEvent(new Event('input'));
    expect(root.querySelector('.decode-btn').disabled).toBe(false);
    expect(root.querySelector('.decode-counter').textContent).toContain('2 lines');
  });

  it('enables Decode when a URL is entered', () => {
    mount();
    const url = root.querySelector('.url-input');
    url.value = 'https://example.com';
    url.dispatchEvent(new Event('input'));
    expect(root.querySelector('.decode-btn').disabled).toBe(false);
    expect(root.querySelector('.decode-counter').textContent).toContain('1 url');
  });

  it('"Try an example" fills the textarea and enables Decode', () => {
    mount();
    root.querySelector('.example-btn').click();
    const ta = root.querySelector('.lineup-input');
    expect(ta.value.length).toBeGreaterThan(10);
    expect(root.querySelector('.decode-btn').disabled).toBe(false);
  });

  it('submits a text payload on Decode click', () => {
    const received = [];
    mount({ onSubmit: (p) => received.push(p) });
    const ta = root.querySelector('.lineup-input');
    ta.value = 'A\nB';
    ta.dispatchEvent(new Event('input'));
    root.querySelector('.decode-btn').click();
    expect(received).toEqual([{ type: 'text', value: 'A\nB', pasteFormat: null }]);
  });

  it('submits a url payload (array) when the URL field is set', () => {
    const received = [];
    mount({ onSubmit: (p) => received.push(p) });
    const url = root.querySelector('.url-input');
    url.value = 'https://example.com/lineup';
    url.dispatchEvent(new Event('input'));
    root.querySelector('.decode-btn').click();
    expect(received).toEqual([{ type: 'url', urls: ['https://example.com/lineup'] }]);
  });

  it('clears the URL rows when text is typed', () => {
    mount();
    const ta = root.querySelector('.lineup-input');
    const url = root.querySelector('.url-input');
    url.value = 'https://example.com';
    url.dispatchEvent(new Event('input'));
    ta.value = 'A';
    ta.dispatchEvent(new Event('input'));
    // The whole row list resets to a single empty row.
    expect(root.querySelectorAll('.url-input').length).toBe(1);
    expect(root.querySelector('.url-input').value).toBe('');
  });

  it('adds and removes URL rows', () => {
    mount();
    expect(root.querySelectorAll('.url-wrap').length).toBe(1);
    // Remove button is hidden while only one row exists.
    expect(root.querySelector('.url-remove').hidden).toBe(true);

    root.querySelector('.url-add').click();
    expect(root.querySelectorAll('.url-wrap').length).toBe(2);
    expect([...root.querySelectorAll('.url-remove')].every((b) => !b.hidden)).toBe(true);

    root.querySelectorAll('.url-remove')[1].click();
    expect(root.querySelectorAll('.url-wrap').length).toBe(1);
    expect(root.querySelector('.url-remove').hidden).toBe(true);
  });

  it('caps URL rows at 10 and hides the add button at the cap', () => {
    mount();
    for (let i = 0; i < 20; i++) root.querySelector('.url-add').click();
    expect(root.querySelectorAll('.url-wrap').length).toBe(10);
    expect(root.querySelector('.url-add').hidden).toBe(true);
  });

  it('merges multiple URL rows into one payload and counts them', () => {
    const received = [];
    mount({ onSubmit: (p) => received.push(p) });
    const setRow = (i, value) => {
      const input = root.querySelectorAll('.url-input')[i];
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    root.querySelector('.url-add').click();
    setRow(0, 'https://fest.example/stage-1');
    setRow(1, 'https://fest.example/stage-2');
    expect(root.querySelector('.decode-counter').textContent).toContain('2 urls');
    root.querySelector('.decode-btn').click();
    expect(received).toEqual([
      { type: 'url', urls: ['https://fest.example/stage-1', 'https://fest.example/stage-2'] },
    ]);
  });

  it('drops blank and duplicate URL rows from the payload', () => {
    const received = [];
    mount({ onSubmit: (p) => received.push(p) });
    const setRow = (i, value) => {
      const input = root.querySelectorAll('.url-input')[i];
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    root.querySelector('.url-add').click();
    root.querySelector('.url-add').click();
    setRow(0, 'https://fest.example/a');
    setRow(1, '   ');
    setRow(2, 'https://fest.example/a');
    root.querySelector('.decode-btn').click();
    expect(received).toEqual([{ type: 'url', urls: ['https://fest.example/a'] }]);
  });
});
