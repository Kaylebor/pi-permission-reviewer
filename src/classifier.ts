export interface CommandClassification {
  action: "skip" | "review" | "human" | "block";
  minimumLevel: number;
  reason: string;
}

const SAFE_COMMANDS = new Set([
  "basename",
  "dirname",
  "head",
  "ls",
  "pwd",
  "tail",
  "tree",
  "wc",
]);

const HARD_BLOCK = [
  /(?:^|[\s'"=])(?:(?:~|\$(?:HOME|USERPROFILE)|\$\{(?:HOME|USERPROFILE)\})\/|\/(?:Users|home)\/[^/]+\/)?(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.config\/gcloud|\.azure|Library\/Keychains)(?:\/|[\s'";]|$)/i,
  /(?:^|[\s/'"])(?:\.netrc|\.npmrc|\.pypirc|\.git-credentials|auth\.json|\.env(?:\.[^\s/'"]*)?)(?:[\s/'";]|$)/i,
  /(?:^|\s)(?:security\s+find-(?:generic|internet)-password|gh\s+auth\s+token)\b/i,
  /(?:^|\s)(?:mkfs(?:\.|\s)|shutdown\b|reboot\b|fork\s*bomb)/i,
  /(?:curl|wget)\b[^|\n]*\|/i,
  /(?:authorization\s*:\s*(?:bearer|basic)|--password(?:=|\s)|--api-key(?:=|\s)|(?:api[_-]?key|access[_-]?token|secret)\s*=\s*['\"]?[A-Za-z0-9_./+~-]{12,})/i,
];

const HUMAN_ONLY = [
  /(?:^|\s)(?:sudo|su)\b/i,
  /(?:^|\s)(?:npm|pnpm|yarn)\s+publish\b/i,
  /(?:^|\s)(?:kubectl|terraform|aws|gcloud|az)\b/i,
  /(?:^|\s)(?:git\s+push|docker\s+push|podman\s+push)\b/i,
];

const COMPLEX_SHELL = /(?:\|\||&&|[|<>;`]|\$\(|\$\{|\b(?:eval|exec|xargs)\b|\bfind\b[^\n]*-exec|\b(?:ba|z|fi)?sh\s+-c\b)/;

export function classifyBash(command: string): CommandClassification {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return { action: "block", minimumLevel: 0, reason: "empty command" };
  }
  if (HARD_BLOCK.some((pattern) => pattern.test(normalized))) {
    return {
      action: "block",
      minimumLevel: 0,
      reason: "matched a deterministic secret, execution, or system safety rule",
    };
  }
  if (HUMAN_ONLY.some((pattern) => pattern.test(normalized))) {
    return {
      action: "human",
      minimumLevel: 1,
      reason: "external, privileged, publishing, or infrastructure side effect",
    };
  }
  if (COMPLEX_SHELL.test(normalized)) {
    return {
      action: "review",
      minimumLevel: 1,
      reason: "complex shell syntax requires deep review",
    };
  }
  const words = normalized.split(" ");
  const commandName = words[0] === "git" ? words.slice(0, 2).join(" ") : words[0];
  if (SAFE_COMMANDS.has(commandName)) {
    return {
      action: "skip",
      minimumLevel: 0,
      reason: "known read-only command; sandbox remains authoritative",
    };
  }
  return {
    action: "review",
    minimumLevel: 0,
    reason: "uncategorized simple command",
  };
}
