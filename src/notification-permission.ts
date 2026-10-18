import { execFile } from 'node:child_process';
import { notificationCommand } from './notifications.js';

const settingsURL = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension';

export const requestNotificationPermission = async (dependencies: any = {}) => {
  const platform = dependencies.platform || process.platform;
  if (platform !== 'darwin') return {
    ok: false, result: 'unsupported_platform', platform,
    message: 'Notification permission requests are supported on macOS. On Linux, configure notifications in your desktop session.',
  };
  const env = dependencies.env || process.env;
  const command = (dependencies.resolveCommand || notificationCommand)(platform, env);
  const execute = dependencies.execFile || execFile;
  const run = (executable: string, args: string[], timeout: number) => new Promise<any>(resolve => {
    let child: any, deadline: any, escalation: any, finished = false;
    const finish = (error: any) => {
      if (finished) return; finished = true;
      clearTimeout(deadline); clearTimeout(escalation);
      dependencies.signal?.removeEventListener('abort', escalate); resolve(error);
    };
    const escalate = () => {
      if (escalation || !child?.pid) return;
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1500);
    };
    try {
      child = execute(executable, args, { env, timeout, maxBuffer: 16384, signal: dependencies.signal }, error => {
        // AbortError can precede process exit. Reap the sender before returning.
        if (error?.name === 'AbortError' && child?.pid && child.exitCode === null && child.signalCode === null) child.once('close', () => finish(error));
        else finish(error);
      });
      if (!finished && child?.pid) {
        deadline = setTimeout(escalate, timeout);
        dependencies.signal?.addEventListener('abort', escalate, { once: true });
        if (dependencies.signal?.aborted) escalate();
      }
    } catch (error) { finish(error); }
  });
  // terminal-notifier 3 requests authorization before submitting a message.
  // Allow time for a human to answer; ordinary alerts retain their short timeout.
  const error = await run(command, ['-title', 'Roadmap Runner', '-message',
    'Notification permission request completed. Roadmap Runner can now submit desktop alerts.',
    '-group', 'roadmap-runner-permission'], dependencies.timeoutMs || 120000);
  const cancelled = () => ({ ok: false, result: 'cancelled', platform, backend: command, message: 'Notification permission request cancelled.' });
  if (dependencies.signal?.aborted || error?.name === 'AbortError') return cancelled();
  if (!error) return { ok: true, result: 'submitted', platform, backend: command,
    message: 'Permission request completed; a confirmation notification was submitted. Focus and other macOS settings still determine display.' };
  if (error.code === 3) {
    const settingsError = await run('/usr/bin/open', [settingsURL], 5000);
    if (dependencies.signal?.aborted || settingsError?.name === 'AbortError') return cancelled();
    return { ok: false, result: 'permission_denied', platform, backend: command, settingsOpened: !settingsError,
      message: `Notification permission was denied. ${settingsError ? 'Open' : 'Opened'} System Settings > Notifications; enable terminal-notifier, then run this command again.` };
  }
  const result = error.code === 'ENOENT' ? 'backend_unavailable'
    : error.killed ? 'request_timeout' : 'delivery_failed';
  const message = result === 'backend_unavailable' ? 'Install terminal-notifier with brew install terminal-notifier, then run this command again.'
    : result === 'request_timeout' ? 'Notification permission request timed out after waiting for a response. Run this command again in a logged-in macOS desktop session.'
    : `Notification permission request failed. Run ${command} -diagnose in a logged-in macOS desktop session.`;
  return { ok: false, result, platform, backend: command, message };
};
