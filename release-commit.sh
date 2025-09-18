 git checkout -b release
 git add -f main.js styles.css manifest.json
 git commit -m "build: Release v1.0.0"
 git push origin release
 git checkout develop
