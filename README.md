# Obsidian Google Drive Sync Plugin

이 플러그인은 Richard Xiong이 제작한 원본 [Google Drive Sync](https://github.com/RichardX366/Obsidian-Google-Drive) 플러그인을 기반으로, 사용자 정의 인증 서버를 지원하도록 수정된 버전입니다.

**현재 버전:** V1.0.0
**수정자:** Peng. (ORG:Richard Xiong)

## Disclaimer

-   이 플러그인은 Obsidian 팀이 제공하는 [공식 동기화 서비스](https://obsidian.md/sync)가 아닙니다.
-   이 플러그인은 외부 서버와 통신합니다. 기본적으로 Google Drive API와 통신하며, 인증 토큰 교환을 위해 사용자가 직접 지정한 서버와 통신합니다.

## Caution

**이 플러그인을 사용하기 전에는 반드시 볼트(Vault)를 백업하십시오. 데이터 유실의 위험이 있을 수 있습니다.**

## 주요 기능

-   양방향 동기화 (Obsidian -> Google Drive, Google Drive -> Obsidian)
-   여러 기기 간 동기화 지원 (Windows, MacOS, iOS 테스트 완료)
-   로컬 파일 우선 동기화 (충돌 자동 해결)
-   **사용자 정의 인증 서버 지원**

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

-   **Pull (가져오기)**: Obsidian을 시작할 때 또는 명령어(`Google Drive: Pull from Google Drive`)를 통해 자동으로 Google Drive의 변경사항을 가져옵니다.
-   **Push (내보내기)**: 로컬 볼트의 변경사항을 Google Drive로 보내려면, 좌측 리본 메뉴의 동기화 아이콘을 클릭하거나 명령어(`Google Drive: Push to Google Drive`)를 실행합니다.
-   **Reset (초기화)**: 로컬 상태를 Google Drive의 상태로 강제로 덮어쓰려면 명령어(`Google Drive: Reset local vault to Google Drive`)를 실행합니다. **(주의: 로컬 변경사항이 사라질 수 있습니다.)**

## 주의사항

-   데이터 손실을 방지하기 위해, Google Drive에 생성된 플러그인 폴더에 수동으로 파일을 업로드하거나 다른 동기화 프로그램을 함께 사용하지 마십시오.
-   가급적 Obsidian 앱 내에서만 파일을 수정하십시오. 외부에서 파일을 변경하면 변경사항이 추적되지 않을 수 있습니다.

## 개발가이드
-  npm audit fix --force
-  npm fund
-  npm install
-  npm run build
