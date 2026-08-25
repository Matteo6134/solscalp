/**
 * Minimal terminal drawing. Presentation only -- no decisions, no thresholds.
 *
 * Deliberately dependency-free: a dashboard is a convenience, and pulling a TUI
 * library into a project whose whole point is auditability would add a lot of
 * transitive code for some box-drawing characters.
 *
 * Everything degrades rather than breaks: an unknown terminal size falls back to
 * 80x24, over-long text is clipped to the pane, and a pane given more rows than
 * it has content simply ends early.
 */

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export const ANSI = Object.freeze({
  clear: '[2J',
  home: '[H',
  hideCursor: '[?25l',
  showCursor: '[?25h',
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
  grey: '[90m',
});

/** @returns {{cols: number, rows: number}} */
export const size = (stream = process.stdout) =>
  Object.freeze({
    cols: Number.isInteger(stream.columns) && stream.columns > 20 ? stream.columns : DEFAULT_COLS,
    rows: Number.isInteger(stream.rows) && stream.rows > 8 ? stream.rows : DEFAULT_ROWS,
  });

/** Printable length, ignoring ANSI escapes, so padding maths stays correct. */
export const visibleLength = (text) => stripAnsi(text).length;

export const stripAnsi = (text) => String(text).replace(/\[[0-9;]*m/g, '');

/** Clip to `width` printable characters. Escapes are preserved but not counted. */
export function clip(text, width) {
  const s = String(text);
  if (visibleLength(s) <= width) return s;
  // Simple path: when there are no escapes, slice directly.
  if (s === stripAnsi(s)) return s.slice(0, Math.max(0, width - 1)) + '…';
  let out = '';
  let seen = 0;
  let i = 0;
  while (i < s.length && seen < width - 1) {
    const esc = /^\[[0-9;]*m/.exec(s.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length;
      continue;
    }
    out += s[i];
    i += 1;
    seen += 1;
  }
  return `${out}…${ANSI.reset}`;
}

/** Pad to `width` printable characters. */
export const pad = (text, width) => {
  const s = String(text);
  const gap = width - visibleLength(s);
  return gap > 0 ? s + ' '.repeat(gap) : clip(s, width);
};

/**
 * A titled pane. Returns the rendered lines, exactly `rows` of them, so panes
 * stack predictably regardless of how much content they were given.
 * @param {object} p
 * @param {string} p.title
 * @param {readonly string[]} p.lines
 * @param {number} p.cols
 * @param {number} p.rows total rows INCLUDING the title bar
 * @param {string} [p.note] right-aligned in the title bar
 */
export function pane({ title, lines, cols, rows, note = '' }) {
  const inner = Math.max(0, cols - 2);
  const head = `${ANSI.bold}${ANSI.cyan}${title}${ANSI.reset}`;
  const rightRoom = inner - visibleLength(title) - 1;
  const bar =
    note && rightRoom > visibleLength(note)
      ? `${head} ${ANSI.grey}${'─'.repeat(rightRoom - visibleLength(note))}${note}${ANSI.reset}`
      : `${head} ${ANSI.grey}${'─'.repeat(Math.max(0, rightRoom))}${ANSI.reset}`;

  const body = lines.slice(0, Math.max(0, rows - 1)).map((l) => ` ${clip(l, inner)}`);
  while (body.length < rows - 1) body.push('');
  return [bar, ...body];
}

/** Repaint the whole screen from a list of lines. One write, so no tearing. */
export function paint(lines, stream = process.stdout) {
  stream.write(ANSI.home + lines.join('\n') + ANSI.clear.replace('2J', '0J'));
}

/**
 * Take over the terminal, and guarantee it is handed back.
 *
 * The cursor is hidden while drawing; leaving it hidden after a crash makes the
 * user's shell look broken, so restoration is wired to every exit path including
 * an uncaught throw.
 * @param {() => Promise<void>} run
 */
export async function withScreen(run) {
  const restore = () => {
    process.stdout.write(ANSI.showCursor + ANSI.reset + '\n');
  };
  process.stdout.write(ANSI.hideCursor + ANSI.clear + ANSI.home);
  const onExit = () => {
    restore();
    process.exit(0);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);
  try {
    await run();
  } finally {
    process.off('SIGINT', onExit);
    process.off('SIGTERM', onExit);
    restore();
  }
}

/** A fixed-size ring of recent events, newest last. Immutable. */
export function ring(capacity) {
  let items = Object.freeze([]);
  return Object.freeze({
    push(item) {
      const next = [...items, item];
      items = Object.freeze(next.slice(Math.max(0, next.length - capacity)));
      return items;
    },
    all: () => items,
  });
}
