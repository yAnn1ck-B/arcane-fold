import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, nextVersion, validateVersionValues } from './check-version.mjs';

test('every release advances stable SemVer without lexical ordering mistakes', () => {
  assert.equal(nextVersion('0.2.9'), '0.2.10');
  assert.equal(nextVersion('0.2.9', 'minor'), '0.3.0');
  assert.equal(nextVersion('0.2.9', 'major'), '1.0.0');
  assert.equal(nextVersion('0.2.9', '0.4.1'), '0.4.1');
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1);
  for (const requested of ['0.2.9', '0.1.0', 'v0.3.0', '0.3', '01.3.0', '0.3.0-beta']) assert.throws(() => nextVersion('0.2.9', requested));
});
test('mismatched manifests or tags stop release preparation', () => {
  assert.equal(validateVersionValues({ npm: '0.2.0', cargo: '0.2.0' }, 'v0.2.0'), '0.2.0');
  assert.throws(() => validateVersionValues({ npm: '0.2.0', cargo: '0.1.0' }));
  assert.throws(() => validateVersionValues({ npm: '0.2.0', cargo: '0.2.0' }, 'v0.2.1'));
  assert.throws(() => validateVersionValues({ npm: '0.2.0', cargo: undefined }));
});
