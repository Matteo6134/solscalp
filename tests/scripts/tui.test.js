import { describe, expect, it } from 'vitest';
import { ANSI, clip, pad, paint, pane, ring, size, stripAnsi, visibleLength } from '../../scripts/lib/tui.js';

describe('visibleLength / stripAnsi', () => {
  it('ignores escape sequences when measuring', () => {
    const coloured = `${ANSI.green}SAFE${ANSI.reset}`;

    expect(visibleLength(coloured)).toBe(4);
    expect(stripAnsi(coloured)).toBe('SAFE');
  });

  it('measures plain text unchanged', () => {
    expect(visibleLength('hello')).toBe(5);
  });
});

describe('clip', () => {
  it('leaves short text alone', () => {
    expect(clip('abc', 10)).toBe('abc');
  });

  it('truncates plain text with an ellipsis', () => {
    expect(clip('abcdefghij', 5)).toBe('abcd…');
    expect(visibleLength(clip('abcdefghij', 5))).toBe(5);
  });

  it('counts only PRINTABLE characters when clipping coloured text', () => {
    // the naive version would count the escape bytes and cut the visible text
    // far too early, which is how a table column silently loses its content
    const coloured = `${ANSI.green}abcdefghij${ANSI.reset}`;
    const clipped = clip(coloured, 5);

    expect(visibleLength(clipped)).toBe(5);
    expect(stripAnsi(clipped)).toBe('abcd…');
  });

  it('always terminates colour so it cannot bleed into the next cell', () => {
    const clipped = clip(`${ANSI.red}abcdefghij${ANSI.reset}`, 4);

    expect(clipped.endsWith(ANSI.reset)).toBe(true);
  });

  it('handles a zero or negative width without throwing', () => {
    expect(() => clip('abc', 0)).not.toThrow();
    expect(() => clip('abc', -5)).not.toThrow();
  });
});

describe('pad', () => {
  it('pads plain text to the requested printable width', () => {
    expect(pad('ab', 5)).toBe('ab   ');
  });

  it('pads by PRINTABLE width, so coloured columns still line up', () => {
    const padded = pad(`${ANSI.green}ab${ANSI.reset}`, 5);

    expect(visibleLength(padded)).toBe(5);
  });

  it('clips instead of overflowing when the text is too long', () => {
    expect(visibleLength(pad('abcdefgh', 4))).toBe(4);
  });
});

describe('pane', () => {
  it('always returns exactly the requested number of rows', () => {
    for (const rows of [2, 5, 10]) {
      expect(pane({ title: 'T', lines: ['a', 'b'], cols: 40, rows })).toHaveLength(rows);
    }
  });

  it('drops content that does not fit rather than overflowing the pane', () => {
    const out = pane({ title: 'T', lines: ['a', 'b', 'c', 'd'], cols: 40, rows: 3 });

    expect(out).toHaveLength(3);
    expect(stripAnsi(out.join('\n'))).toContain('a');
    expect(stripAnsi(out.join('\n'))).not.toContain('d');
  });

  it('keeps every rendered line inside the column budget', () => {
    const out = pane({ title: 'T', lines: ['x'.repeat(200)], cols: 30, rows: 3 });

    for (const l of out) expect(visibleLength(l)).toBeLessThanOrEqual(30);
  });

  it('renders a note in the title bar when there is room', () => {
    const out = pane({ title: 'T', lines: [], cols: 60, rows: 2, note: 'NOTE' });

    expect(stripAnsi(out[0])).toContain('NOTE');
  });

  it('drops the note rather than overflowing a narrow pane', () => {
    const out = pane({ title: 'TITLE', lines: [], cols: 12, rows: 2, note: 'A-VERY-LONG-NOTE' });

    expect(visibleLength(out[0])).toBeLessThanOrEqual(12);
  });
});

describe('size', () => {
  it('falls back to sane defaults for an unknown terminal', () => {
    expect(size({})).toEqual({ cols: 80, rows: 24 });
    expect(size({ columns: 5, rows: 2 })).toEqual({ cols: 80, rows: 24 });
  });

  it('uses the real size when it is plausible', () => {
    expect(size({ columns: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
  });
});

describe('ring', () => {
  it('keeps only the newest N items, in order', () => {
    const r = ring(3);
    for (const n of [1, 2, 3, 4, 5]) r.push(n);

    expect(r.all()).toEqual([3, 4, 5]);
  });

  it('returns frozen snapshots that cannot rewrite history', () => {
    const r = ring(2);
    r.push('a');

    expect(Object.isFrozen(r.all())).toBe(true);
    expect(() => r.all().push('b')).toThrow();
  });

  it('is empty until pushed', () => {
    expect(ring(5).all()).toEqual([]);
  });
});

describe('paint -- the overlap bug', () => {
  /**
   * A line one character too long wraps, pushing every line below it down by
   * one, and the trailing erase cannot repair that because the content has been
   * shoved into rows still in use. The visible result is text on top of itself.
   * Measured before the fix: the dash header was 81 chars and the footer 86 on
   * an 80-column terminal.
   */
  const fakeStream = (cols, rows) => {
    const writes = [];
    return { columns: cols, rows, write: (s) => writes.push(s), writes };
  };

  it('clips every line to the terminal width', () => {
    const s = fakeStream(40, 20);
    paint(['x'.repeat(100), 'short'], s);
    const body = s.writes.join('');
    for (const l of stripAnsi(body).split('\n')) {
      expect(l.length).toBeLessThanOrEqual(40);
    }
  });

  it('clips coloured lines by PRINTABLE width, not byte length', () => {
    const s = fakeStream(30, 20);
    paint([`${ANSI.green}${'y'.repeat(80)}${ANSI.reset}`], s);
    const line = s.writes.join('').split('\n')[0];
    expect(visibleLength(line.replace(/\x1b\[H|\x1b\[0J/g, ''))).toBeLessThanOrEqual(30);
  });

  it('never writes more rows than the terminal has', () => {
    const s = fakeStream(40, 10);
    paint(Array.from({ length: 50 }, (_, i) => `line ${i}`), s);
    const rendered = stripAnsi(s.writes.join('')).split('\n');
    // one row is reserved so the last line does not scroll the header away
    expect(rendered.length).toBeLessThanOrEqual(10);
  });

  it('still emits an erase-to-end so shorter frames leave no residue', () => {
    const s = fakeStream(40, 20);
    paint(['a'], s);
    expect(s.writes.join('')).toContain('[0J');
  });

  it('falls back to sane dimensions for a stream with none', () => {
    const s = { write: (x) => x };
    expect(() => paint(['a'], s)).not.toThrow();
  });
});
