# Launches Chrome with remote debugging enabled, pointed at a COPY of the
# real profile (D:\claude-work\chrome-debug-profile), not the live one.
#
# Chrome refuses to open the DevTools debug port on the OS-default profile
# path even when --user-data-dir explicitly names it ("DevTools remote
# debugging requires a non-default data directory"). Pointing at a copy
# is the workaround; it carries over cookies/logins but not live state.
#
# Re-sync the copy first if you want current logins:
#   robocopy "$env:LOCALAPPDATA\Google\Chrome\User Data" D:\claude-work\chrome-debug-profile /E /XD Cache "Code Cache" GPUCache CacheStorage GrShaderCache ShaderCache component_crx_cache Crashpad "Service Worker"

Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="D:\claude-work\chrome-debug-profile"
