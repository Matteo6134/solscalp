import v8 from 'node:v8';
import { createElement as h } from 'react';
import { render } from 'ink';
import { App } from './scripts/dash.js';

const SECONDS = Number(process.env.SECONDS ?? 70);
const fakeStdout = {
  isTTY: true, columns: 100, rows: 40, destroyed: false, writableEnded: false,
  writable: true, writableLength: 0, _writableState: { length: 0 },
  write(c, cb) { if (typeof cb === 'function') cb(); return true; },
  on() { return this; }, off() { return this; }, once() { return this; },
  removeListener() { return this; }, emit() { return false; }, listenerCount() { return 0; },
  end() {}, cork() {}, uncork() {},
};
const fakeStdin = {
  isTTY: false, setEncoding() {}, setRawMode() {}, ref() {}, unref() {}, read() { return null; },
  on() { return this; }, off() { return this; }, once() { return this; },
  addListener() { return this; }, removeListener() { return this; }, unshift() {},
  listenerCount() { return 0; }, resume() {}, pause() {},
};
const app = render(
  h(App, { dir: 'data/recordings', refreshMs: 3000, initialView: 'live', cols: 100, openDetail: false }),
  { stdout: fakeStdout, stdin: fakeStdin, stderr: process.stderr, interactive: true, patchConsole: true },
);
setTimeout(() => {
  global.gc(); global.gc(); global.gc();
  const p = v8.writeHeapSnapshot('c:/tmp/dash-leak.heapsnapshot');
  process.stderr.write(`snapshot: ${p} heap=${(process.memoryUsage().heapUsed/1048576).toFixed(1)}MB\n`);
  process.exit(0);
}, SECONDS * 1000);
