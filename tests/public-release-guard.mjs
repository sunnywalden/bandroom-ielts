// Public-release guard: the tracked product source must not contain the
// operator's personal identity, local paths, production URL, or real seeded
// learning records. The foundation phase is synthetic sample data only.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, extname} from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const MARKERS = [
  'Henry', 'HZ</span>', '/Users/henry', 'sunnywalden0209',
  'Westhaven', 'inflated the tire', '2026-10-29', '2026-10-30',
];
function* walk(dir){
  for(const name of readdirSync(dir)){
    const p = join(dir, name);
    if(statSync(p).isDirectory()){ yield* walk(p); }
    else if(['.ts','.tsx','.py','.md'].includes(extname(p))) yield p;
  }
}
test('product source carries no personal identity or real seeded records', ()=>{
  const offenders = [];
  for(const base of ['app','lib','runner','analysis']){
    for(const p of walk(join(ROOT, base))){
      const text = readFileSync(p, 'utf8');
      for(const m of MARKERS) if(text.includes(m)) offenders.push(`${p}: ${m}`);
    }
  }
  assert.deepEqual(offenders, [], 'personal markers must not appear in tracked source');
});
test('foundation seed is labelled synthetic and identity is session-driven', ()=>{
  const ledger = readFileSync(join(ROOT,'app/ledger.ts'),'utf8');
  assert.match(ledger, /SYNTHETIC/);
  assert.match(ledger, /SAMPLE DATA/);
  assert.match(ledger, /sampleEpoch/);
  const studio = readFileSync(join(ROOT,'app/studio.tsx'),'utf8');
  assert.match(studio, /displayName/);
  assert.doesNotMatch(studio, /<b>Henry<\/b>/);
  const route = readFileSync(join(ROOT,'app/api/state/route.ts'),'utf8');
  assert.match(route, /displayName:user\.displayName/);
});
