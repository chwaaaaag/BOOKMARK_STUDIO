# Bookmark Studio — Web

빌드 없이 동작하는 정적 웹앱입니다. PDF 렌더링은 [PDF.js](https://mozilla.github.io/pdf.js/) 3.11(CDN)을 사용합니다.

## 실행

- `index.html` 을 브라우저로 바로 열거나,
- 아무 정적 서버로 이 폴더를 제공하세요: `python -m http.server` → <http://localhost:8000>
- GitHub Pages 등에 그대로 올려도 됩니다.

인터넷 연결이 필요합니다(PDF.js · Pretendard 폰트 CDN).

## 데이터

- 연 PDF와 읽은 위치·책갈피·메모는 **이 브라우저의 IndexedDB** 에 저장되어 다음에 서재에서 바로 열립니다.
  파일은 서버로 전송되지 않습니다.
- 설정(테마, 보기 방식 등)은 `localStorage` 에 저장됩니다.
- 브라우저 저장 공간이 부족하면 해당 책은 "이번 세션에만 열림"으로 표시됩니다.
- `?open=<PDF URL>` 로 같은 출처(또는 CORS 허용) PDF를 바로 열 수 있습니다.

## 기능 요약

서재(표지, 이어 읽기, 진행률) · 한 쪽 / 두 쪽(3D 책장 넘김) / 연속 스크롤 · 목차 · 페이지 미리보기 ·
책갈피와 메모 · 본문 검색(하이라이트, 결과 목록) · 텍스트 선택·복사 · 링크 · 암호 PDF ·
라이트 / 세피아 / 다크 테마와 야간 페이지 · 확대(Ctrl+휠, 더블 클릭) · 회전 · 전체 화면 ·
터치 스와이프 · 모바일 레이아웃 · 단축키(`?`)

## 구조

```
index.html
css/style.css
js/icons.js   인라인 SVG 아이콘
js/store.js   IndexedDB / localStorage
js/pages.js   PDF.js 래퍼 (페이지 렌더링, 텍스트 레이어, 링크, 검색, 목차)
js/app.js     UI, 서재, 탐색, 애니메이션, 단축키
```
