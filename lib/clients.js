import { validProviderThreadId } from './continuation.js';

export const CLIENT_NAMES = ["codex", "claude", "gemini", "grok", "kimi", "muse"];
export const CLIENT_CAPABILITIES = { codex: { continuation: true } };

export function buildClientInvocation({ client, prompt, workdir, model = "", effort = "", executable = "",
  persistSession = false, resumeSessionId = null }) {
  if ((persistSession || resumeSessionId) && client !== 'codex') throw new Error('Session continuation is supported only by the Codex adapter');
  if (resumeSessionId && (!persistSession || !validProviderThreadId(resumeSessionId))) throw new Error('Resume requires an explicit valid provider thread ID and session persistence');
  switch (client) {
    case "codex": {
      const command = executable || "codex";
      const args = [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        "--skip-git-repo-check",
      ];
      if (!persistSession) args.push('--ephemeral');
      args.push('--cd', workdir);
      if (model) args.push("--model", model);
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      // Parent exec options precede resume because --cd is not a resume option.
      // Verified against official Codex CLI docs/source and local 0.163.0 help.
      if (resumeSessionId) args.push('resume', resumeSessionId);
      args.push(prompt);
      return { command, args, output: "codex-json", approvalFree: true };
    }

    case "claude": {
      const command = executable || "claude";
      const args = ["-p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose"];
      if (model) args.push("--model", model);
      args.push(prompt);
      return { command, args, output: "claude-json", approvalFree: true };
    }

    case "gemini": {
      const command = executable || "gemini";
      const args = [
        "-p",
        prompt,
        "--skip-trust",
        "--approval-mode=yolo",
        "--output-format",
        "text",
      ];
      if (model) args.push("--model", model);
      return { command, args, output: "text", approvalFree: true };
    }

    case "grok": {
      const command = executable || "grok";
      const args = ["-p", prompt, "--yolo"];
      return { command, args, output: "text", approvalFree: true };
    }

    case "kimi": {
      const command = executable || "kimi";
      const args = ["-p", prompt];
      return { command, args, output: "text", approvalFree: false };
    }

    case "muse": {
      const command = executable || "muse";
      const args = ["exec", "--yolo", prompt];
      return { command, args, output: "text", approvalFree: true };
    }

    default:
      throw new Error(`Unsupported client: ${client}`);
  }
}
