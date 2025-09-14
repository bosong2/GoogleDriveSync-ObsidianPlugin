# Obsidian Google Drive Sync Plugin 개발 계획서

## 1. 프로젝트 개요

기존 `Google Drive Sync` 플러그인을 기반으로, 사용자 정의 서버 설정 기능을 추가하고 플러그인 정보를 수정한 새로운 버전으로 재배포하는 것을 목표로 합니다.

- **수정 후 플러그인 이름**: Obsidian Google Drive Sync Plugin
- **수정 후 플러그인 버전**: V1.0.0
- **수정 후 제작자**: Peng. (ORG:Richard Xiong)

## 2. 단계별 개발 계획

### Phase 1: 프로젝트 기본 정보 수정 및 환경 설정

- **목표**: 플러그인의 기본 메타데이터를 수정하고, 개발 및 빌드 환경을 검증합니다.
- **작업 상세**:
    1.  **`manifest.json` 수정**:
        -   `id`: `google-drive-sync` (유지 또는 변경 검토)
        -   `name`: `Obsidian Google Drive Sync Plugin`으로 변경
        -   `version`: `V1.0.0`으로 변경
        -   `author`: `Peng. (ORG:Richard Xiong)`으로 변경
    2.  **`versions.json` 수정**:
        -   `V1.0.0` 버전에 대한 정보를 추가하고, 기존 버전을 `2.2.2`로 업데이트하여 버전 충돌을 방지합니다.
    3.  **개발 환경 구축**:
        -   `yarn install` 명령을 실행하여 프로젝트 의존성을 모두 설치합니다.
    4.  **빌드 테스트**:
        -   `yarn build` 명령을 실행하여 수정 전 코드가 정상적으로 컴파일 및 빌드되는지 확인합니다.

### Phase 2: 사용자 정의 서버 URL 설정 기능 구현

- **목표**: 하드코딩된 서버 URL을 사용자가 직접 설정할 수 있도록 UI를 추가하고, 관련 로직을 구현합니다.
- **작업 상세**:
    1.  **`main.ts` - 설정 인터페이스(`PluginSettings`) 수정**:
        -   `PluginSettings` 인터페이스에 `ServerURL: string` 속성을 추가합니다.
        -   `DEFAULT_SETTINGS` 객체에 `ServerURL: ''` (기본값)을 추가합니다.
    2.  **`main.ts` - 설정 UI (`SettingsTab`) 수정**:
        -   `Refresh token` 입력란 아래에 새로운 `Setting` 항목을 추가합니다.
        -   `Server URL`이라는 이름의 텍스트 입력 박스(`addText`)를 생성합니다.
        -   입력 박스 옆에 `Save` 버튼을 추가합니다.
    3.  **`main.ts` - 'Save' 버튼 로직 구현**:
        -   `onClick` 이벤트 핸들러를 `async` 함수로 구현합니다.
        -   **입력값 검증**:
            -   URL 형식 검사 (정규식 또는 `new URL()` 활용).
            -   포트 번호 포함 가능.
            -   Injection 공격 방지를 위한 특수문자 제한 (허용 문자: 영문, 숫자, `-`, `.`, `:`, `/`, `?`, `=`, `&`, `_`).
        -   **서버 연결 테스트**:
            -   검증된 URL의 `/api/ping` 엔드포인트로 `GET` 요청을 보내 정상 응답(HTTP 200)을 확인하는 헬퍼 함수를 `helpers/ky.ts`에 추가합니다. (기존 `checkConnection` 함수 활용)
        -   **설정 저장**:
            -   모든 검증 통과 시, `this.plugin.settings.ServerURL`에 값을 저장하고 `this.plugin.saveSettings()`를 호출합니다.
            -   성공/실패 여부를 `Notice`로 사용자에게 알립니다.
    4.  **하드코딩된 URL 교체**:
        -   `helpers/ky.ts`의 `refreshAccessToken` 함수와 `helpers/drive.ts`의 `checkConnection` 함수 등에서 사용되던 `https://ogd.richardxiong.com` 주소를 `this.plugin.settings.ServerURL`에서 가져오도록 수정합니다.

### Phase 3: Refresh Token 검증 로직 수정

- **목표**: 실시간 토큰 검증 방식을 버튼 클릭 방식으로 변경하여 사용자 경험과 시스템 부하를 개선합니다.
- **작업 상세**:
    1.  **`main.ts` - 설정 UI (`SettingsTab`) 수정**:
        -   `Refresh token` 입력 박스의 `onChange` 이벤트에 연결된 검증 로직을 제거합니다.
        -   입력 박스 옆에 `Check` 버튼을 추가합니다.
    2.  **`main.ts` - 'Check' 버튼 로직 구현**:
        -   `onClick` 이벤트 핸들러를 `async` 함수로 구현합니다.
        -   **선행 조건 검사**: `this.plugin.settings.ServerURL`이 저장되어 있는지 확인합니다. 저장되지 않았다면, 서버 URL을 먼저 저장하라는 `Notice`를 표시하고 로직을 중단합니다.
        -   **토큰 유효성 검사**:
            -   `helpers/ky.ts`의 `refreshAccessToken` 함수를 호출하여 액세스 토큰 발급을 테스트합니다. 이 함수는 이제 사용자 정의 서버 URL을 사용합니다.
            -   테스트 성공/실패 여부를 `Notice`로 사용자에게 명확히 알립니다.

### Phase 4: 최종 테스트 및 빌드

- **목표**: 수정된 모든 기능이 정상적으로 동작하는지 종합적으로 테스트하고, 최종 배포판을 생성합니다.
- **작업 상세**:
    1.  **단위 기능 테스트**:
        -   **서버 URL 설정**: 유효하지 않은 URL, 연결 불가능한 URL, 정상 URL 입력 시 각각의 경우에 맞게 `Save` 버튼이 동작하는지 확인합니다.
        -   **토큰 검증**: 서버 URL 설정 전/후, 유효한 토큰/유효하지 않은 토큰 입력 시 `Check` 버튼이 정상 동작하는지 확인합니다.
    2.  **통합 기능 테스트**:
        -   새로운 설정으로 `Push`, `Pull`, `Reset` 등 플러그인의 핵심 동기화 기능이 모두 정상적으로 동작하는지 확인합니다.
    3.  **최종 빌드**:
        -   `yarn build` 명령을 실행하여 `main.js`, `styles.css`, `manifest.json`을 포함한 최종 배포 파일을 생성합니다.
    4.  **코드 정리**:
        -   주석, 불필요한 `console.log` 등을 제거하고 코드 스타일을 통일합니다.

