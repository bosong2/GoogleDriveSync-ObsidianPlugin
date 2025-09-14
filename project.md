# Obsidian-Google-Drive 프로젝트 분석

## 1. 개요

이 프로젝트는 Obsidian 노트와 Google Drive를 동기화하는 비공식 플러그인입니다. 사용자는 Obsidian 내에서 명령어를 사용하여 로컬 노트를 Google Drive에 업로드(Push)하거나, Google Drive에 있는 파일을 로컬 볼트(Vault)로 다운로드(Pull)할 수 있습니다. iOS를 포함한 여러 기기 간 동기화를 지원합니다.

## 2. 주요 기능

- **양방향 동기화**:
    - **Push (업로드)**: 로컬 Obsidian 볼트의 변경사항(생성, 수정, 삭제)을 Google Drive에 반영합니다.
    - **Pull (다운로드)**: Google Drive의 최신 상태를 로컬 볼트로 가져옵니다.
    - 동기화 충돌 시 로컬 파일을 우선적으로 처리하는 자동 해결 기능이 있습니다.
- **Google Drive 연동**:
    - OAuth 2.0 리프레시 토큰을 사용하여 사용자의 Google Drive 계정과 안전하게 연동합니다.
    - 플러그인은 파일 동기화에 필요한 API(파일 목록 조회, 생성, 업로드, 다운로드, 삭제)만 사용합니다.
- **명령어 (Commands)**:
    - `Push to Google Drive`: 로컬 변경사항을 Google Drive로 업로드합니다.
    - `Pull from Google Drive`: Google Drive로부터 최신 파일을 다운로드합니다.
    - `Reset local vault to Google Drive`: 로컬 볼트의 내용을 Google Drive의 상태로 초기화합니다. (로컬 변경사항 유실)
- **파일 변경 감지**:
    - Obsidian 내에서 파일의 생성, 삭제, 수정, 이름 변경 이벤트를 감지하여 동기화할 작업 목록(`operations`)을 관리합니다.
- **설정 (Settings)**:
    - Google Drive 연동을 위한 리프레시 토큰을 설정하는 메뉴를 제공합니다.
    - 설정 시 볼트가 비어있는지 확인하여 데이터 유실을 방지하는 가이드가 포함되어 있습니다.

## 3. 기술 스택 및 주요 파일

- **언어**: TypeScript
- **프레임워크/API**: Obsidian Plugin API
- **HTTP 클라이언트**: `ky` (브라우저 `fetch` 기반)
- **번들러**: esbuild

### 주요 파일 분석:

- **`main.ts`**: 플러그인의 메인 진입점입니다.
    - 플러그인 로드 시(`onload`) 명령어(Push/Pull/Reset), 리본 메뉴, 설정 탭을 등록합니다.
    - 파일 시스템 이벤트(`create`, `delete`, `modify`, `rename`)를 감지하여 동기화 대상을 기록합니다.
    - 앱 시작 시 자동 `Pull`을 수행하여 최신 상태를 유지합니다.
- **`helpers/drive.ts`**: Google Drive API와의 모든 통신을 담당합니다.
    - `ky.ts`를 기반으로 한 HTTP 클라이언트를 생성하고, API 요청 전후의 훅(hook)을 통해 액세스 토큰을 관리합니다.
    - 파일/폴더 생성, 업로드, 다운로드, 삭제, 메타데이터 업데이트 등 Google Drive와 관련된 저수준(low-level) 기능들을 구현합니다.
- **`helpers/push.ts`**: 'Push' 로직을 구현합니다.
    - 동기화가 필요한 작업 목록을 사용자에게 확인받는 모달(Modal)을 띄웁니다.
    - `drive.ts`의 함수를 호출하여 로컬 파일 시스템의 변경사항(생성, 수정, 삭제)을 Google Drive에 반영합니다.
- **`helpers/pull.ts`**: 'Pull' 로직을 구현합니다.
    - `drive.ts`를 이용해 마지막 동기화 이후 Google Drive에서 변경된 파일 목록을 가져옵니다.
    - 원격 변경사항(생성, 수정, 삭제)을 로컬 볼트에 적용합니다.
- **`helpers/reset.ts`**: 'Reset' 로직을 구현합니다.
    - 로컬의 모든 변경사항을 무시하고, Google Drive의 데이터를 기준으로 로컬 볼트를 덮어쓰는 기능을 수행합니다. 사용자에게 경고 모달을 통해 재확인 받습니다.
- **`manifest.json`**: 플러그인의 이름, 버전, 설명 등 기본 메타데이터를 정의합니다.
- **`package.json`**: 프로젝트의 의존성(typescript, esbuild 등) 및 빌드 스크립트를 정의합니다.
