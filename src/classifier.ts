export interface CommandClassification {
  action: "skip" | "review" | "human" | "block";
  minimumLevel: number;
  reason: string;
}

const HARD_BLOCK = [
  /(?:^|[\s'"=])(?:(?:~|\$(?:HOME|USERPROFILE)|\$\{(?:HOME|USERPROFILE)\})\/|\/(?:Users|home)\/[^/]+\/)?(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.config\/gcloud|\.azure|Library\/Keychains)(?:\/|[\s'";]|$)/i,
  /(?:^|[\s/'"])(?:\.netrc|\.npmrc|\.pypirc|\.git-credentials|auth\.json|\.env(?:\.[^\s/'"]*)?)(?:[\s/'";]|$)/i,
  /(?:^|\s)(?:security\s+find-(?:generic|internet)-password|gh\s+auth\s+token)\b/i,
  /(?:^|\s)(?:mkfs(?:\.|\s)|shutdown\b|reboot\b|fork\s*bomb)/i,
  /(?:authorization\s*:\s*(?:bearer|basic)|--password(?:=|\s)|--api-key(?:=|\s)|(?:api[_-]?key|access[_-]?token|secret)\s*=\s*['\"]?[A-Za-z0-9_./+~-]{12,})/i,
];

// Dataflow operators defeat command-name allowlists and materially change the
// action. Once deterministic deny rules have run, always send them to the stronger
// reviewer before applying human-only or known-safe shortcuts.
const SHELL_INTERPRETERS = new Set([
  "ash",
  "bash",
  "dash",
  "fish",
  "ksh",
  "sh",
  "zsh",
]);

const HUMAN_ONLY = [
  /(?:^|\s)(?:sudo|su)\b/i,
  /(?:^|\s)(?:npm|pnpm|yarn)\s+publish\b/i,
  /(?:^|\s)(?:kubectl|terraform|aws|gcloud|az)\b/i,
  /(?:^|\s)(?:git\s+push|docker\s+push|podman\s+push)\b/i,
];

const COMPLEX_SHELL = /(?:\|\||&&|[|<>;`]|\$\(|\$\{|\b(?:eval|exec|xargs)\b|\bfind\b[^\n]*-exec|\b(?:ba|z|fi)?sh\s+-c\b)/;

export function classifyBash(
  command: string,
  options: { publicKeyPaths?: readonly string[] } = {},
): CommandClassification {
  const source = command.trim();
  const normalized = source.replace(/\s+/g, " ");
  if (!normalized) {
    return { action: "block", minimumLevel: 0, reason: "empty command" };
  }
  const shellDataflow = scanShellDataflow(source);
  const sensitiveInput = maskExactPublicKeyPaths(normalized, options.publicKeyPaths ?? []);
  if (
    HARD_BLOCK.some((pattern) => pattern.test(sensitiveInput)) ||
    isRemoteShellPipeline(shellDataflow.pipelineGroups)
  ) {
    return {
      action: "block",
      minimumLevel: 0,
      reason: "matched a deterministic secret, execution, or system safety rule",
    };
  }
  if (shellDataflow.hasPipeOrRedirection) {
    return {
      action: "review",
      minimumLevel: 1,
      reason: "shell pipe or redirection requires deep review",
    };
  }
  if (HUMAN_ONLY.some((pattern) => pattern.test(normalized))) {
    return {
      action: "human",
      minimumLevel: 1,
      reason: "external, privileged, publishing, or infrastructure side effect",
    };
  }
  if (COMPLEX_SHELL.test(maskQuotedDataflowOperators(source))) {
    return {
      action: "review",
      minimumLevel: 1,
      reason: "complex shell syntax requires deep review",
    };
  }
  return {
    action: "skip",
    minimumLevel: 0,
    reason: "no proactive rule matched; sandbox boundary remains authoritative",
  };
}

function maskExactPublicKeyPaths(command: string, paths: readonly string[]): string {
  let masked = command;
  for (const path of [...new Set(paths)].sort((a, b) => b.length - a.length)) {
    const escaped = path.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    masked = masked.replace(
      new RegExp(`(^|[\\s'\"=])${escaped}(?=$|[\\s'\";|&<>])`, "g"),
      "$1[VALIDATED_PUBLIC_KEY]",
    );
  }
  return masked;
}

function maskQuotedDataflowOperators(command: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  return [...command].map((character) => {
    if (escaped) {
      escaped = false;
      return /[|<>]/.test(character) ? " " : character;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      return character;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      return /[|<>]/.test(character) ? " " : character;
    }
    if (character === "'" || character === '"') quote = character;
    return character;
  }).join("");
}

interface ShellDataflow {
  hasPipeOrRedirection: boolean;
  pipelineGroups: string[][][];
}

/** Minimal shell lexer for routing only; execution remains delegated to Pi/SRT. */
function scanShellDataflow(command: string): ShellDataflow {
  const groups: string[][][] = [];
  let segments: string[][] = [[]];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let hasPipeOrRedirection = false;
  const pushToken = () => {
    if (token) segments.at(-1)!.push(token);
    token = "";
  };
  const pushGroup = () => {
    pushToken();
    if (segments.some((segment) => segment.length > 0)) groups.push(segments);
    segments = [[]];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\n") {
      pushGroup();
      continue;
    }
    if (/\s/.test(character)) {
      pushToken();
      continue;
    }
    if (character === "#" && token === "") {
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      continue;
    }
    if (character === "|" && command[index + 1] === "|") {
      index += 1;
      pushGroup();
      continue;
    }
    if (character === "|") {
      pushToken();
      hasPipeOrRedirection = true;
      if (command[index + 1] === "&") index += 1;
      segments.push([]);
      continue;
    }
    if (character === "<" || character === ">") {
      pushToken();
      hasPipeOrRedirection = true;
      if (command[index + 1] === character) index += 1;
      if (command[index + 1] === "&") index += 1;
      continue;
    }
    if (character === "&" && command[index + 1] === ">") {
      hasPipeOrRedirection = true;
      index += 1;
      if (command[index + 1] === ">") index += 1;
      continue;
    }
    if (character === ";" || character === "&") {
      if (character === ";" && command[index + 1] === ";") index += 1;
      pushGroup();
      continue;
    }
    token += character;
  }
  pushGroup();
  return { hasPipeOrRedirection, pipelineGroups: groups };
}

function isRemoteShellPipeline(groups: string[][][]): boolean {
  for (const segments of groups) {
    let remoteSourceSeen = false;
    for (const segment of segments) {
      const executable = unwrapExecutable(segment);
      if (executable === "curl" || executable === "wget") remoteSourceSeen = true;
      else if (remoteSourceSeen && executable && SHELL_INTERPRETERS.has(executable)) {
        return true;
      }
    }
  }
  return false;
}

function unwrapExecutable(words: string[]): string | undefined {
  let index = 0;
  const skipAssignments = () => {
    while (/^[A-Za-z_]\w*=/.test(words[index] ?? "")) index += 1;
  };
  skipAssignments();
  for (let wrappers = 0; wrappers < 8 && index < words.length; wrappers += 1) {
    const executable = basename(words[index++]!);
    if (executable === "!") {
      skipAssignments();
      continue;
    }
    if (executable === "time") {
      while ((words[index] ?? "").startsWith("-")) {
        const option = words[index++]!;
        if (["-o", "--output", "-f", "--format"].includes(option)) index += 1;
      }
      skipAssignments();
      continue;
    }
    if (executable === "busybox") {
      return words[index] ? basename(words[index]) : undefined;
    }
    if (executable === "command" || executable === "nohup") {
      while ((words[index] ?? "").startsWith("-")) index += 1;
      skipAssignments();
      continue;
    }
    if (executable === "exec") {
      while ((words[index] ?? "").startsWith("-")) {
        if (words[index] === "-a") index += 2;
        else index += 1;
      }
      skipAssignments();
      continue;
    }
    if (executable === "env" || executable === "sudo" || executable === "nice") {
      while ((words[index] ?? "").startsWith("-") || /^[A-Za-z_]\w*=/.test(words[index] ?? "")) {
        const option = words[index++]!;
        if (["-u", "--unset", "-C", "--chdir", "-n", "--adjustment", "-u", "--user", "-g", "--group"].includes(option)) {
          index += 1;
        }
      }
      continue;
    }
    return executable;
  }
  return undefined;
}

function basename(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1).toLowerCase();
}
