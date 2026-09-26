export const CLIENT_NAMES = ["codex", "claude", "gemini", "grok", "kimi", "muse"];

export function buildClientInvocation({ client, prompt, workdir, model = "", effort = "", executable = "" }) {
  switch (client) {
    case "codex": {
      const command = executable || "codex";
      const args = [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "--cd",
        workdir,
      ];
      if (model) args.push("--model", model);
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      args.push(prompt);
      return { command, args, output: "codex-json", approvalFree: true };
    }

    case "claude": {
      const command = executable || "claude";
      const args = ["-p", "--permission-mode", "bypassPermissions"];
      if (model) args.push("--model", model);
      args.push(prompt);
      return { command, args, output: "text", approvalFree: true };
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
