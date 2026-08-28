import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export const MODES = Object.freeze({
  PAPER: 'paper',
  REAL: 'real',
});

const DEFAULT_FILE = join(process.cwd(), 'data', 'trade_mode.json');

/**
 * Get current trading mode from disk. Defaults to 'paper'.
 * @param {string} [filePath]
 * @returns {'paper'|'real'}
 */
export function getTradingMode(filePath = DEFAULT_FILE) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (data.mode === MODES.REAL) return MODES.REAL;
    return MODES.PAPER;
  } catch {
    return MODES.PAPER;
  }
}

/**
 * Set current trading mode to 'paper' or 'real'.
 * @param {'paper'|'real'} mode
 * @param {string} [filePath]
 * @returns {'paper'|'real'}
 */
export function setTradingMode(mode, filePath = DEFAULT_FILE) {
  const target = mode === MODES.REAL ? MODES.REAL : MODES.PAPER;
  try {
    mkdirSync(join(process.cwd(), 'data'), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({ mode: target, updatedAt: Date.now(), iso: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch (err) {
    console.error(`[modeManager] failed to persist mode: ${err.message}`);
  }
  return target;
}
