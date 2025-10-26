# Obsidian Google Drive Sync Plugin

Obsidian 볼트와 Google Drive 간의 양방향 동기화를 제공하는 개선된 플러그인입니다. 원본 프로젝트를 기반으로 다양한 기능과 안정성을 개선했습니다.

**GitHub Repository:** [https://github.com/bosong2/GoogleDriveSync-ObsidianPlugin](https://github.com/bosong2/GoogleDriveSync-ObsidianPlugin)  
**버전:** 1.0.0  
**개발자:** Peng

## Disclaimer

-   이 플러그인은 Obsidian 팀이 제공하는 [공식 동기화 서비스](https://obsidian.md/sync)가 아닙니다.
-   이 플러그인은 외부 서버와 통신합니다. 기본적으로 Google Drive API와 통신하며, 인증 토큰 교환을 위해 사용자가 직접 지정한 서버와 통신합니다.

## Caution

**이 플러그인을 사용하기 전에는 반드시 볼트(Vault)를 백업하십시오. 데이터 유실의 위험이 있을 수 있습니다.**

## 주요 기능

### 🔄 동기화 기능
-   **양방향 동기화**: Obsidian ↔ Google Drive 완전 동기화
-   **다중 기기 지원**: Windows, macOS, iOS에서 테스트 완료
-   **로컬 우선 정책**: 충돌 시 로컬 변경사항 우선 보호
-   **실시간 변경 추적**: 파일 생성, 수정, 삭제, 이동 자동 감지

### 🚀 개선된 기능
-   **지능형 파일 스캔**: 중복 업로드 방지 및 상태 비교 분석
-   **고급 충돌 해결**: 자동 백업 생성 및 수동 해결 지원
-   **에러 관리 시스템**: 실패한 동기화 추적 및 재시도 로직
-   **사용자 정의 서버**: 개인 인증 서버 지원

### 📱 사용성 개선
-   **직관적인 UI**: 동기화 상태 및 진행률 표시
-   **세밀한 제어**: 파일별 동기화 큐 관리
-   **상세한 로깅**: 모든 동기화 과정 추적 가능

## 설치 및 설정 방법

이 플러그인은 인증 토큰 교환을 위해 별도의 서버를 필요로 합니다. 원본 프로젝트의 서버 코드를 참고하여 직접 서버를 구축해야 합니다.

### 1단계: 서버 URL 설정

1.  Obsidian에서 `설정` -> `커뮤니티 플러그인`으로 이동하여 `Obsidian Google Drive Sync Plugin`을 활성화합니다.
2.  플러그인 설정 창을 엽니다.
3.  직접 구축한 인증 서버의 주소(예: `http://localhost:3000`)를 **Server URL** 입력란에 기입합니다.
4.  **Save** 버튼을 클릭합니다. 플러그인이 서버 주소의 유효성을 검사하고 연결 가능 여부를 확인합니다. "Server URL saved successfully." 알림이 뜨면 성공입니다.

### 2단계: Refresh Token 설정

1.  설정 창 상단의 **Get refresh token** 링크를 클릭합니다. (이 링크는 방금 저장한 Server URL로 연결됩니다.)
2.  브라우저에서 서버에 로그인하고, 화면에 표시되는 **Refresh Token**을 복사합니다.
3.  플러그인 설정 창으로 돌아와 **Refresh token** 입력란에 복사한 토큰을 붙여넣습니다.
4.  **Check** 버튼을 클릭합니다. 플러그인이 서버와 통신하여 토큰의 유효성을 검증합니다. "Refresh token is valid and has been saved!" 알림이 뜨면 성공입니다.

### 3단계: 플러그인 재시작

모든 설정이 완료되었습니다. Obsidian을 완전히 종료했다가 다시 시작하면 동기화가 활성화됩니다.

## 사용법

### 기본 동기화 작업

-   **Pull (가져오기)**: Obsidian 시작 시 자동 실행 또는 명령어 `Google Drive: Pull from Google Drive`
-   **Push (내보내기)**: 리본 아이콘 클릭 또는 명령어 `Google Drive: Push to Google Drive`
-   **Reset (초기화)**: 명령어 `Google Drive: Reset local vault to Google Drive` ⚠️ **(주의: 로컬 변경사항 삭제)**

### 초기 볼트 설정

처음 설정하거나 기존 파일들을 동기화할 때:

1. **파일 스캔**: 설정 → "Initial Vault Sync" → "Scan All Files" 클릭
   - 로컬 파일과 Google Drive 상태를 지능적으로 분석
   - 중복 파일 생성 방지
   - 누락된 파일 매핑 복원
2. **업로드**: 스캔 완료 후 "Push"를 실행하여 큐에 있는 파일들을 Google Drive에 업로드

### 고급 기능

-   **동기화 큐 확인**: 설정에서 대기 중인 동기화 작업 조회
-   **에러 관리**: 실패한 동기화 작업 확인 및 해결
-   **충돌 해결**: `.conflict.backup` 파일을 통한 수동 충돌 해결

## 주의사항

-   **백업 필수**: 사용 전 반드시 볼트를 백업하세요
-   **단독 사용**: Google Drive 폴더에 다른 동기화 프로그램이나 수동 파일 업로드 금지
-   **앱 내 수정**: 가급적 Obsidian 앱 내에서만 파일을 수정하세요
-   **네트워크 필요**: 동기화를 위한 안정적인 인터넷 연결 필요

## 문제 해결

### 일반적인 문제

**"Please set up your refresh token first"**
- 설정에서 유효한 Refresh Token을 입력하세요

**"Server is not reachable"**
- Server URL을 확인하고 인증 서버가 실행 중인지 확인하세요
- 네트워크 연결을 확인하세요

**동기화 충돌**
- 볼트에서 `.conflict.backup` 파일을 확인하세요
- 수동으로 충돌을 해결하고 백업 파일을 삭제하세요

**파일이 동기화되지 않음**
- "Scan All Files"를 사용하여 동기화 상태를 새로고침하세요
- 설정에서 동기화 큐 상태를 확인하세요
- 에러 로그에서 구체적인 문제를 확인하세요

## 개발 가이드

```bash
npm install
npm run build
```

## 시스템 요구사항

- **Obsidian**: 1.6.0 이상
- **플랫폼**: 데스크톱 (Windows, macOS, Linux), 모바일 (iOS, Android)
- **네트워크**: 동기화를 위한 인터넷 연결
- **인증 서버**: 토큰 교환을 위한 사용자 정의 서버 설정 필요

## Thanks

이 프로젝트는 [Richard Xiong](https://github.com/RichardX366)의 원본 [Obsidian Google Drive Sync](https://github.com/RichardX366/Obsidian-Google-Drive) 플러그인을 기반으로 제작되었습니다. 훌륭한 기초 작업을 제공해 주신 원작자에게 감사드립니다.
