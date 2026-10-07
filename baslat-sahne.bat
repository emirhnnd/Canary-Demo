@echo off
setlocal
title Canary demo - sahne modu
cd /d "%~dp0"

echo.
echo   Canary demo (SAHNE / scripted mod) baslatiliyor...
echo   Internet ve Gemini gerekmez; hazir senaryo oynatilir.
echo.

if not exist "node_modules" (
  echo   Frontend paketleri kuruluyor...
  call npm install || goto :hata
)
if not exist "server\node_modules" (
  echo   Backend paketleri kuruluyor...
  pushd server
  call npm install || goto :hata
  popd
)

if not exist ".env.local" (
  echo VITE_API_URL=http://localhost:8787> ".env.local"
  echo   .env.local olusturuldu.
)

start "Canary BACKEND (sahne)" /D "%~dp0server" cmd /k npm run dev:scripted
timeout /t 3 /nobreak >nul
start "Canary FRONTEND" /D "%~dp0" cmd /k npm run dev -- --open

echo   Iki pencere acildi. Tarayici birazdan kendiliginden acilacak.
echo   Kapatmak icin iki penceredeki islemi Ctrl+C ile durdurun.
timeout /t 5 >nul
exit /b 0

:hata
echo.
echo   Kurulum basarisiz oldu. Yukaridaki hata mesajini kontrol edin.
pause
exit /b 1
