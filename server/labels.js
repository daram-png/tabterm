// labels.js — worker/session 라벨 검증 + 워커 라벨 영속 저장
// 세션 라벨은 sessions.js 의 PtySession.label in-memory mutate (이 모듈 책임 아님).

const CONTROL_RE = /[\x00-\x1f\x7f]/;

export function validateLabel(input) {
  if (typeof input !== 'string') return { ok: false, error: 'type' };
  const value = input.trim();
  if (value === '') return { ok: true, value: '' };
  if (value.length > 32) return { ok: false, error: 'too_long' };
  if (CONTROL_RE.test(value)) return { ok: false, error: 'control_char' };
  return { ok: true, value };
}
