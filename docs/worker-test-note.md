# worker-test 폴더 설명

`C:\workspace\worker-test/` 는 OpenCode + OMO install 시점 (2026-05-22) 의
smoke test 용도로 만들어진 폴더. tabterm 의 UI 에는 노출되지 않음 (의도적).

## 용도

- OpenCode TUI 직접 테스트 (manual `cd C:\workspace\worker-test && opencode`)
- OMO hook/skill 동작 검증
- 새 OMO config 변경 사항 검증 (model swap, category routing 등)

## 왜 tabterm 의 9번째 워커로 만들지 않았나

tabterm 의 worker model 은 index 기반 (worker-0..worker-N, N=WORKERS_COUNT-1).
worker-test 를 9번째 탭으로 추가하려면:
1. WORKERS_COUNT=9 + worker-test 를 worker-8 로 rename (균일 명명 + index 정합성)
2. 또는 worker-test 라는 비표준 이름을 special-case 처리 (코드 복잡도 증가, index
   가정에 edge bug 위험)

smoke test 가 이미 통과했고 (Phase 10 verified) 영구 사용 패턴 없음 → 활성화 X.
필요하면 manual cmd 로만 사용.

## 활성화하려면

별도 결정 후 진행. 권장 절차:
1. `C:\workspace\worker-test` 를 `C:\workspace\worker-8` 로 rename
2. tabterm `.env` 의 `WORKERS_COUNT=8` 을 `9` 로 변경
3. tabterm 재시작 (외부 cmd, 본 docs 옆의 nssm-install-runbook.md 참조)
4. 사이드바에 worker-8 추가됨 확인

## 참고

OMO install plan Task #6 의 deferred 항목. 의도적으로 deferred.
