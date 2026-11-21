# Waits for the running Codex firewall job, then starts the update-publishing task.
param([int]$WaitPid)
if ($WaitPid) { Wait-Process -Id $WaitPid -ErrorAction SilentlyContinue }
$c = Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin" -Recurse -Filter codex.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -Expand FullName
$prompt = "Read E:\Projeler\CudeIDE\CODEX_GOREV_GUNCELLEME_YAYINI_20KAS.md fully (Turkish) and implement it in E:\Projeler\CudeIDE. Do not edit website/, gateway/roles.js or gateway/roles-admin.js. Never put the release private key into the repository or logs. Do not commit or push and do not upload anything to GitHub (use -DryRun for testing). Run npm run compile and npm test in extensions/cude-ai and node --test in gateway. Finish with RAPOR_GUNCELLEME_YAYINI_20KAS.md (Turkish)."
& $c exec -C 'E:\Projeler\CudeIDE' -s workspace-write -m gpt-6.1-sol -c 'model_reasoning_effort="medium"' --skip-git-repo-check $prompt *> 'E:\Projeler\CudeIDE\codex-yayin.log'
'codex chain finished'
