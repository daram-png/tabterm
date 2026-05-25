# tabterm NSSM Service Install Runbook

이 문서는 tabterm 을 nssm 서비스로 등록하는 절차. 사용자가 외부 cmd 에서 직접
실행해야 함 (현재 tabterm 안의 Claude/OpenCode 세션에서 실행 시 그 세션이 죽음).

## 사전 조건

- nssm 2.24 이상 설치 (C:/Tools/nssm-2.24/ 또는 PATH 에 nssm.exe)
- node, npm 설치 확인
- 기존 nopersb-oauth-proxy 가 nssm 으로 동작 중 (참고 패턴)

## 실행 절차

1. 현재 tabterm 안의 활성 작업 모두 저장/종료
2. 브라우저에서 tabterm 탭 닫기
3. 외부 elevated PowerShell 열기 (`Win+X` → `Windows Terminal (Administrator)`)
4. 기존 manual tabterm 프로세스 확인 및 종료:
   ```
   Get-Process node | Where-Object { $_.CommandLine -like '*tabterm*' } | Select-Object Id, ProcessName
   # 위에서 PID 확인 후
   taskkill /PID <PID> /F
   ```
5. nssm 서비스 install:
   ```
   nssm install tabterm "C:\Program Files\nodejs\node.exe" "C:\Tools\tabterm\server\index.js"
   nssm set tabterm AppDirectory "C:\Tools\tabterm"
   nssm set tabterm AppStdout "C:\Tools\nssm-2.24\logs\tabterm-stdout.log"
   nssm set tabterm AppStderr "C:\Tools\nssm-2.24\logs\tabterm-stderr.log"
   nssm set tabterm AppRotateFiles 1
   nssm set tabterm AppRotateBytes 10485760
   nssm set tabterm Start SERVICE_AUTO_START
   ```
6. LocalSystem 환경 변수 (필수 — `~/.claude`, `~/.config` 같은 path 가 Administrator
   home 을 가리키게):
   ```
   nssm set tabterm AppEnvironmentExtra "USERPROFILE=C:\Users\Administrator" "HOME=C:\Users\Administrator"
   ```
7. 서비스 시작:
   ```
   nssm start tabterm
   ```
8. 상태 확인:
   ```
   Get-Service tabterm | Format-List Name, Status, StartType
   # status: Running, StartType: Automatic 확인
   Get-Content "C:\Tools\nssm-2.24\logs\tabterm-stdout.log" -Tail 30
   # "listening on http://127.0.0.1:3007" 같은 startup 메시지 확인
   ```
9. 브라우저로 tabterm URL 다시 접속 (`http://127.0.0.1:3007` 또는 tailscale 도메인)

## 알려진 함정

- `.env` 파일은 AppDirectory 기준으로 dotenv 가 자동 read. AppEnvironmentExtra 에
  중복으로 넣을 필요 없음. 단 USERPROFILE/HOME 은 LocalSystem 기본값이 잘못되므로
  반드시 override.
- COOKIE_SECURE=true 인 경우 직접 http://127.0.0.1:3007 접속 시 쿠키 저장 안 됨
  (HTTPS 만). tailscale serve 또는 https proxy 통해 접속 필요.
- nopersb-oauth-proxy 와 포트 충돌 없음 (tabterm 3007 vs nopersb 18802).
- watchdog autostart 가 켜져 있으면 (env WATCHDOG_AUTOSTART=true) tabterm 시작
  시 watchdog 도 자동 spawn. 이는 의도된 동작.

## 롤백 (서비스 제거)

```
nssm stop tabterm
nssm remove tabterm confirm
# 그 후 manual 실행으로 복귀: cd C:\Tools\tabterm && npm start
```

## 참고

- 동일 패턴 선례: `nopersb-oauth-proxy` 서비스 등록 (`20260522-160142-worker-opencode-omo-install-plan.md` Phase 8 참조)
- 본 runbook 은 OMO install plan Task #9 의 deferred 항목. 사용자가 OpenCode 안정화
  후 실행하기로 결정.
