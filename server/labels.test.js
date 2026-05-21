import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLabel } from './labels.js';

test('validateLabel: non-string -> type', () => {
  for (const v of [null, undefined, 123, {}, [], true]) {
    const r = validateLabel(v);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'type');
  }
});

test('validateLabel: empty string after trim -> ok, cleared', () => {
  for (const v of ['', '   ', '\t\n  ']) {
    const r = validateLabel(v);
    assert.equal(r.ok, true);
    assert.equal(r.value, '');
  }
});

test('validateLabel: too long (33 UTF-16 code units) -> too_long', () => {
  const v = 'a'.repeat(33);
  const r = validateLabel(v);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'too_long');
});

test('validateLabel: exactly 32 code units -> ok', () => {
  const v = 'a'.repeat(32);
  const r = validateLabel(v);
  assert.equal(r.ok, true);
  assert.equal(r.value, v);
});

test('validateLabel: control chars -> control_char', () => {
  for (const c of ['\x00', '\x1f', '\x7f', 'good\x01here']) {
    const r = validateLabel(c);
    assert.equal(r.ok, false, `expected fail for char ${JSON.stringify(c)}`);
    assert.equal(r.error, 'control_char');
  }
});

test('validateLabel: trims surrounding whitespace', () => {
  const r = validateLabel('  pixiechess  ');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'pixiechess');
});

test('validateLabel: emoji allowed', () => {
  const r = validateLabel('🚀 pixie');
  assert.equal(r.ok, true);
  assert.equal(r.value, '🚀 pixie');
});
