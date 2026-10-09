#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "לא נמצא Node.js במחשב שלך."
  echo "היכנס ל-https://nodejs.org והתקן את הגרסה המומלצת (LTS), ואז הרץ את הקובץ הזה שוב."
  read -p "לחץ Enter לסגירה..."
  exit 1
fi
echo "בודק תלויות (מהיר אם שום דבר לא השתנה)..."
npm install
echo ""
echo "מפעיל את האפליקציה..."
echo "בעוד רגע פתח בדפדפן: http://localhost:3000"
echo ""
node server.js
