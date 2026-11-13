// Long-poll behind kb_access_status(wait_seconds): hold the call until the request is decided or expired.
import { isTerminal, watchRequest } from "./access";
import { SlotLimiter } from "./slotLimiter";

export const MAX_WAIT_SECONDS = 50;
export const MAX_WAITS_PER_SESSION = 3;
export const MAX_WAITS_PER_IP = 10;
export const MAX_WAITS_TOTAL = 50;

const slots = new SlotLimiter(MAX_WAITS_TOTAL);

// Resolves when the request is terminal, `seconds` elapsed, `signal` aborted or the server shuts down.
// False (at once) when a cap is reached: the wait was skipped.
export function waitForDecision(owner: { session: string; ip: string }, requestId: string, seconds: number, signal: AbortSignal): Promise<boolean> {
  const release = slots.acquire([
    [`s:${owner.session}`, MAX_WAITS_PER_SESSION],
    [`ip:${owner.ip}`, MAX_WAITS_PER_IP],
  ]);
  if (!release) return Promise.resolve(false);
  return new Promise((resolve) => {
    let stop = (): void => {};
    const finish = (): void => {
      stop();
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      release();
      resolve(true);
    };
    const timer = setTimeout(finish, seconds * 1000);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) return finish();
    const watch = watchRequest(requestId, (w) => isTerminal(w) && finish(), finish);
    if (!watch || isTerminal(watch.word)) return finish();
    stop = watch.stop;
  });
}
