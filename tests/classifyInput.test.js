import { describe, it, expect } from 'vitest';
import { classifyInput } from '../src/core/classifyInput.js';

describe('classifyInput', () => {
  it('treats one-per-line names as lineup text', () => {
    const r = classifyInput('Atmos\nFilteria\nDOOF');
    expect(r.urls).toEqual([]);
    expect(r.text).toBe('Atmos\nFilteria\nDOOF');
    expect(r.actCount).toBe(3);
  });

  it('pulls out whole-line URLs', () => {
    const r = classifyInput('https://fest.example/main\nhttps://fest.example/tent');
    expect(r.urls).toEqual(['https://fest.example/main', 'https://fest.example/tent']);
    expect(r.text).toBe('');
    expect(r.actCount).toBe(0);
  });

  it('separates a mix of links and text', () => {
    const r = classifyInput('Atmos\nhttps://fest.example/main\nFilteria');
    expect(r.urls).toEqual(['https://fest.example/main']);
    expect(r.text).toBe('Atmos\nFilteria');
    expect(r.actCount).toBe(2);
  });

  it('promotes bare www. hosts to https', () => {
    const r = classifyInput('www.fest.example/lineup');
    expect(r.urls).toEqual(['https://www.fest.example/lineup']);
  });

  it('dedupes repeated URLs', () => {
    const r = classifyInput('https://fest.example/a\nhttps://fest.example/a');
    expect(r.urls).toEqual(['https://fest.example/a']);
  });

  it('leaves links embedded in prose as text', () => {
    const r = classifyInput('Tickets at https://fest.example now');
    expect(r.urls).toEqual([]);
    expect(r.text).toBe('Tickets at https://fest.example now');
  });

  it('ignores non-http schemes', () => {
    const r = classifyInput('javascript:alert(1)\nfile:///etc/passwd');
    expect(r.urls).toEqual([]);
    expect(r.actCount).toBe(2);
  });

  it('handles blank input', () => {
    const r = classifyInput('   \n\n  ');
    expect(r.urls).toEqual([]);
    expect(r.text).toBe('');
    expect(r.actCount).toBe(0);
  });
});
