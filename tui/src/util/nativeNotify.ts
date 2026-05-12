// Cross-platform desktop notification, no native deps. Each branch shells
// out to the OS's bundled tool:
//   • macOS  → osascript display notification
//   • Linux  → notify-send (libnotify, present on most distros)
//   • Win32  → PowerShell + BurntToast-free toast via Windows.UI.Notifications
//
// Failures are swallowed — a missing notify-send shouldn't crash a flow run.
// Strings are escaped before being interpolated into shell strings to keep
// quotes / backslashes safe.

import { spawn } from "node:child_process"

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

export function nativeNotify(title: string, body?: string, sound = true): void {
  try {
    if (process.platform === "darwin") {
      const t = escapeAppleScript(title)
      const b = escapeAppleScript(body ?? "")
      const soundClause = sound ? ' sound name "default"' : ""
      const script = `display notification "${b}" with title "${t}"${soundClause}`
      spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref()
      return
    }
    if (process.platform === "linux") {
      const args = [title]
      if (body) args.push(body)
      spawn("notify-send", args, { stdio: "ignore", detached: true }).unref()
      return
    }
    if (process.platform === "win32") {
      const t = title.replace(/"/g, '`"')
      const b = (body ?? "").replace(/"/g, '`"')
      const ps = `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null;` +
        `$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(1);` +
        `$x.GetElementsByTagName('text').Item(0).AppendChild($x.CreateTextNode("${t}"))>$null;` +
        `$x.GetElementsByTagName('text').Item(1).AppendChild($x.CreateTextNode("${b}"))>$null;` +
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('LiquidAgente').Show([Windows.UI.Notifications.ToastNotification]::new($x));`
      spawn("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", detached: true }).unref()
      return
    }
  } catch {
    // No notifier available — silently skip rather than failing the run.
  }
}
