// The harness runs `node /bot/main.ts` (node22). It reads every case from /input/cases.json (a JSON
// array of {id, input}), answers each one alone with run() from solve.js, and writes /output/answers.json: a JSON
// array of the answers, one per case and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its work runs under it (the rules: the house
// baseline runs with --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
// Serialise per value (JSON.stringify of each string) rather than of the whole
// tree: measurably faster for a large flat object of long strings, and the
// bytes are identical (string keys in insertion order, values escaped the same).
const parts: string[] = ['['];
for (let i = 0; i < answers.length; i++) {
  if (i) parts.push(',');
  const o = answers[i] as Record<string, string>;
  parts.push('{');
  let first = true;
  for (const k in o) {
    if (!first) parts.push(',');
    first = false;
    parts.push(JSON.stringify(k), ':', JSON.stringify(o[k]));
  }
  parts.push('}');
}
parts.push(']');
writeFileSync(join(OUTPUT_DIR, 'answers.json'), parts.join(''));
