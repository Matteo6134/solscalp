// Drives dash.js's App through Ink with a fake TTY stdout, and reports heap growth.
import { createElement as h } from 'react';
import { render } from 'ink';
import { App } from './scripts/dash.js';

const MODE = process.env.MODE ?? 'consume';   // consume | stall
const SECONDS = Number(process.env.SECONDS ?? 60);
const REFRESH = Number(process.env.REFRESH ?? 3000);
const DIR = process.env.DIR ?? 'data/recordings';

let bytes = 0, writes = 0, biggest = 0;
const stalled = [];   // when MODE=stall, keep chunks like a backed-up Writable

const fakeStdout = {
  isTTY: true,
  columns: 100,
  rows: 40,
  destroyed: false,
  writableEnded: false,
  writable: true,
  writableLength: 0,
  _writableState: { length: 0 },
  write(chunk, cb) {
    writes++;
    bytes += chunk.length;
    if (chunk.length > biggest) biggest = chunk.length;
    if (MODE === 'stall') stalled.push(Buffer.from(String(chunk), 'utf8'));
    if (typeof cb === 'function') cb();
    return true;
  },
  on() { return this; }, off() { return this; },
  once() { return this; }, removeListener() { return this; },
  emit() { return false; }, listenerCount() { return 0; },
  end() {}, cork() {}, uncork() {},
};

const fakeStdin = {
  isTTY: false,
  setEncoding() {}, setRawMode() {}, ref() {}, unref() {}, read() { return null; },
  on() { return this; }, off() { return this; }, once() { return this; },
  addListener() { return this; }, removeListener() { return this; },
  unshift() {}, listenerCount() { return 0; }, resume() {}, pause() {},
};

const mb = (n) => (n / 1048576).toFixed(1);
const sample = () => { global.gc(); global.gc(); return process.memoryUsage(); };

const app = render(
  h(App, { dir: DIR, refreshMs: REFRESH, initialView: 'live', cols: 100, openDetail: false }),
  { stdout: fakeStdout, stdin: fakeStdin, stderr: process.stderr, interactive: true, patchConsole: true },
);

const t0 = Date.now();
let base = null;
const rows = [];
const probe = setInterval(() => {
  const m = sample();
  const t = (Date.now() - t0) / 1000;
  if (base === null && t > 10) base = { t, heap: m.heapUsed, ext: m.external, writes, bytes };
  rows.push({ t: t.toFixed(0), heap: mb(m.heapUsed), ext: mb(m.external), rss: mb(m.rss), writes, kb: (bytes / 1024).toFixed(0) });
  process.stderr.write(`t=${t.toFixed(0)}s measures=${performance.getEntriesByType('measure').length} heap=${mb(m.heapUsed)}MB ext=${mb(m.external)}MB rss=${mb(m.rss)}MB writes=${writes} out=${(bytes/1024).toFixed(0)}KB biggest=${biggest}B\n`);
}, 10_000);

setTimeout(() => {
  clearInterval(probe);
  const m = sample();
  const t = (Date.now() - t0) / 1000;
  process.stderr.write('\n--- SUMMARY ---\n');
  if (base) {
    const dHeap = m.heapUsed - base.heap;
    const dT = t - base.t;
    const dW = writes - base.writes;
    process.stderr.write(`window ${dT.toFixed(0)}s: heap ${mb(base.heap)} -> ${mb(m.heapUsed)}MB  (delta ${mb(dHeap)}MB)\n`);
    process.stderr.write(`heap growth per hour: ${(dHeap / dT * 3600 / 1048576).toFixed(0)} MB/h\n`);
    process.stderr.write(`writes in window: ${dW} (${(dW/dT).toFixed(1)}/s), bytes ${( (bytes-base.bytes)/1024/dT ).toFixed(1)} KB/s -> ${(((bytes-base.bytes)/dT)*3600/1048576).toFixed(0)} MB/h of stdout\n`);
  }
  process.stderr.write(`biggest single write: ${biggest} bytes\n`);
  app.unmount();
  process.exit(0);
}, SECONDS * 1000);
