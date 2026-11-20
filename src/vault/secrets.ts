// Obvious-secret detector: only distinctive prefixes/shapes, linear-time regexes, first hit wins.
const B = String.raw`(?<![\w-])`;
const PATTERNS: [string, RegExp][] = [
  ["GitHub token", new RegExp(String.raw`${B}gh[pousr]_[A-Za-z0-9]{36,}`)],
  ["GitHub token", new RegExp(String.raw`${B}github_pat_[A-Za-z0-9_]{60,}`)],
  ["Anthropic API key", new RegExp(String.raw`${B}sk-ant-[A-Za-z0-9_-]{32,}`)],
  ["OpenAI API key", new RegExp(String.raw`${B}sk-proj-[A-Za-z0-9_-]{32,}`)],
  ["AWS access key id", new RegExp(String.raw`${B}(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])`)],
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["Slack token", new RegExp(String.raw`${B}xox[abprs]-[A-Za-z0-9-]{10,}`)],
  ["Google API key", new RegExp(String.raw`${B}AIza[0-9A-Za-z_-]{35}(?![\w-])`)],
  ["Stripe live key", new RegExp(String.raw`${B}(?:sk|rk)_live_[A-Za-z0-9]{20,}`)],
  ["second-brain token", new RegExp(String.raw`${B}sb_[A-Za-z0-9_-]{43}(?![\w-])`)],
  ["second-brain connector key", new RegExp(String.raw`${B}sbk_[A-Za-z0-9_-]{43}(?![\w-])`)],
];

export function findSecret(text: string): { kind: string; line: number } | undefined {
  let best: { kind: string; index: number } | undefined;
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(text);
    if (m && (!best || m.index < best.index)) best = { kind, index: m.index };
  }
  if (!best) return undefined;
  let line = 1;
  for (let i = text.indexOf("\n"); i !== -1 && i < best.index; i = text.indexOf("\n", i + 1)) line++;
  return { kind: best.kind, line };
}
