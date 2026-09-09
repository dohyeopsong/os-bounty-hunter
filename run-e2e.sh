#!/usr/bin/env bash
# 엔드투엔드 실행 러너 — 이슈 1번 자동 선택
# 스크립트 자신의 위치를 기준으로 동작 (어디서 호출하든 OK).
cd "$(dirname "$0")" || exit 1
echo "1" | node src/cli.js --lang JavaScript
