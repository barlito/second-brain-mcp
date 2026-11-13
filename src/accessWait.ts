// Long-poll behind kb_access_status(wait_seconds): hold the call until the request is decided or expired.
import { isTerminal, watchRequest } from "./access";

export const MAX_WAIT_SECONDS = 50;
export const MAX_WAITS_PER_SESSION = 3;
export const MAX_WAITS_TOTAL = 50;

const perSession = new Map<string, number>();
let total = 0;

// Resolves when the request is terminal, `seconds` elapsed or `signal` aborted; at once over the caps.
export function waitForDecision(sessionId: string, requestId: string, seconds: number, signal: AbortSignal): Promise<void> {
  const mine = perSession.get(sessionId) ?? 0;
  if (seconds <= 0 || signal.aborted || total >= MAX_WAITS_TOTAL || mine >= MAX_WAITS_PER_SESSION) return Promise.resolve();
  total++;
  perSession.set(sessionId, mine + 1);
  return new Promise((resolve) => {
    let finished = false;
    let stop: (() => void) | undefined;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      stop?.();
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      total--;
      const n = (perSession.get(sessionId) ?? 1) - 1;
      if (n > 0) perSession.set(sessionId, n);
      else perSession.delete(sessionId);
      resolve();
    };
    const timer = setTimeout(finish, seconds * 1000);
    signal.addEventListener("abort", finish, { once: true });
    stop = watchRequest(requestId, (w) => isTerminal(w) && finish());
    if (finished) stop();
  });
}
