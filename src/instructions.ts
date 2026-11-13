// One total budget for the MCP `instructions` string (core + User context). Claude Code cuts
// instructions at 4096 chars (JS string length; older versions 2048), so we stay under it and never
// rely on the client truncating: the final string is always <= the budget, nothing is cut mid-note.
export const INSTRUCTIONS_MAX_CHARS = 4090; // Claude Code cuts only above 4096
export const INSTRUCTIONS_MIN_CHARS = 1000;
export const INSTRUCTIONS_SEPARATOR = "\n\n";

let warned = false;

// MCP_INSTRUCTIONS_MAX_CHARS: integer >= 1000; anything else falls back to the default (warns once).
export function getInstructionsMaxChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCP_INSTRUCTIONS_MAX_CHARS;
  if (raw === undefined || raw.trim() === "") return INSTRUCTIONS_MAX_CHARS;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= INSTRUCTIONS_MIN_CHARS) return n;
  if (!warned) {
    warned = true;
    console.warn(`MCP_INSTRUCTIONS_MAX_CHARS must be an integer >= ${INSTRUCTIONS_MIN_CHARS}; using ${INSTRUCTIONS_MAX_CHARS}`);
  }
  return INSTRUCTIONS_MAX_CHARS;
}

// Chars left for the User context once the core and the separator are counted.
export function userContextBudget(core: string, env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(0, getInstructionsMaxChars(env) - core.length - INSTRUCTIONS_SEPARATOR.length);
}

// Core first (server policy), then user-written data; never above the budget.
export function composeInstructions(core: string, userContext: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!userContext) return core;
  const full = `${core}${INSTRUCTIONS_SEPARATOR}${userContext}`;
  return full.length <= getInstructionsMaxChars(env) ? full : core;
}
