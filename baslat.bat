@echo off
setlocal
title Canary demo - baslatici
cd /d "%~dp0"

echo.
echo   Canary demo (CANLI mod) baslatiliyor...
echo.

rem --- ilk calistirmada paketleri kur ---
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

rem --- frontend'i backend'e bagla ---
if not exist ".env.local" (
  echo VITE_API_URL=http://localhost:8787> ".env.local"
  echo   .env.local olusturuldu.
)

rem --- canli mod Gemini anahtari ister ---
if not exist "server\.env" (
  echo.
  echo   UYARI: server\.env bulunamadi. Gemini olmadan sezgisel modda calisacak.
  echo   Anahtar eklemek icin: server\.env.example dosyasini server\.env olarak kopyalayin.
  echo.
)

rem --- iki ayri pencere: once backend, sonra frontend ---
start "Canary BACKEND (canli)" /D "%~dp0server" cmd /k npm run dev
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
