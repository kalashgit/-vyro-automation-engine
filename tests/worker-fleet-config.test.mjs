import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkerConcurrency } from '../src/modules/workers/fleet-config.mjs';

test('worker defaults to one process and supports thirteen', () => {
  assert.equal(parseWorkerConcurrency(undefined), 1);
  assert.equal(parseWorkerConcurrency(''), 1);
  assert.equal(parseWorkerConcurrency('1'), 1);
  assert.equal(parseWorkerConcurrency('13'), 13);
});
test('rejects unsafe or excessive worker settings', () => {
  for (const value of ['0','14','999','1.5',' 13','1e1','-1','abc']) {
    assert.throws(() => parseWorkerConcurrency(value));
  }
});
