/**
 * When to send a keep-warm ping. Pure, so every rule is testable without a store.
 *
 * Claude Code on a subscription caches the conversation for an hour, renewed by
 * each request. Coming back to an idle task after that re-writes the whole
 * context at about twice the input price, while a tiny prompt within the hour
 * only reads it back at about a tenth. So an idle conversation gets a prompt
 * that asks the model to do nothing, shortly before its cache would expire.
 */

export const KEEP_WARM_PROMPT = 'Keep-alive ping: reply with only "ok" and do nothing else.';

/** Claude Code's subscription cache lasts 60 minutes; the ping has to land first. */
export const DEFAULT_KEEP_WARM_INTERVAL_MINUTES = 55;
export const MIN_KEEP_WARM_INTERVAL_MINUTES = 5;
export const MAX_KEEP_WARM_INTERVAL_MINUTES = 59;
/** How long a task is kept warm after its last real activity before it is left to go cold. */
export const DEFAULT_KEEP_WARM_MAX_HOURS = 12;
export const MIN_KEEP_WARM_MAX_HOURS = 1;
export const MAX_KEEP_WARM_MAX_HOURS = 24;

export function clampKeepWarmIntervalMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_KEEP_WARM_INTERVAL_MINUTES;
  return Math.min(
    MAX_KEEP_WARM_INTERVAL_MINUTES,
    Math.max(MIN_KEEP_WARM_INTERVAL_MINUTES, Math.round(minutes)),
  );
}

export function clampKeepWarmMaxHours(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULT_KEEP_WARM_MAX_HOURS;
  return Math.min(MAX_KEEP_WARM_MAX_HOURS, Math.max(MIN_KEEP_WARM_MAX_HOURS, Math.round(hours)));
}

export interface KeepWarmSettings {
  enabled: boolean;
  intervalMinutes: number;
  maxHours: number;
}

/** What the app knows about one agent pane at the moment of deciding. */
export interface KeepWarmFacts {
  /** In the task list: not closed, closing, archived (collapsed) or landed. */
  taskOpen: boolean;
  /** Claude Code in a terminal; other agents and the chat view are left alone. */
  claudeTerminal: boolean;
  /** The process runs (not exited, not suspended). */
  processAlive: boolean;
  /** A coordinator drives the task: a ping would confuse its `wait_for_idle`. */
  coordinated: boolean;
  /** The session has had a turn; a fresh one has no conversation worth keeping. */
  hasConversation: boolean;
  /** Mid-turn, by the app's hook-first activity tracking. */
  busy: boolean;
  /** Waiting on the user: a question, a permission prompt, a menu on screen,
   *  or anything else that puts the task in "Needs you". */
  needsUser: boolean;
  /** A draft in the prompt box or the terminal, or the user typing right now. */
  userInput: boolean;
  /** Something else is queued to reach the agent: the task's own prompt, a
   *  staged notification, a peer message, another automatic write. */
  pendingDelivery: boolean;
  /** The terminal is mounted and has printed since the agent started, so the
   *  screen checks behind `needsUser` see what is really there. */
  screenObserved: boolean;
  /** When the agent was last active: its turn's end as its hooks report it,
   *  else its last terminal output. Hooks win because a status line repainting
   *  on a timer would make the output look busy forever. */
  lastActivityAt: number | undefined;
}

/** Pings sent since the agent's last real activity. */
export interface KeepWarmStreak {
  firstPingAt: number;
  lastPingAt: number;
  /** `lastActivityAt` once the latest ping's turn had ended; anything later is real activity. */
  settledActivityAt?: number;
  /** The latest ping failed or was not answered; wait for real activity. */
  stopped?: boolean;
}

export type KeepWarmSkip =
  | 'disabled'
  | 'closed'
  | 'not_claude'
  | 'not_running'
  | 'coordinated'
  | 'no_conversation'
  | 'in_flight'
  | 'busy'
  | 'needs_user'
  | 'user_input'
  | 'pending_delivery'
  | 'no_idle_evidence'
  | 'stopped'
  | 'cap_reached'
  | 'not_idle_long_enough';

export type KeepWarmDecision = { ping: true } | { ping: false; skip: KeepWarmSkip };

/**
 * The streak still running, or undefined once the agent showed real activity
 * since the last ping's turn ended, such as a turn of its own. (Prompts and
 * typing end the streak at once, through `forgetKeepWarmPing`.) A streak whose
 * ping is still in flight cannot be judged yet and carries on.
 */
export function continueKeepWarmStreak(
  streak: KeepWarmStreak | undefined,
  lastActivityAt: number | undefined,
): KeepWarmStreak | undefined {
  if (!streak || streak.settledActivityAt === undefined || lastActivityAt === undefined)
    return streak;
  return lastActivityAt > streak.settledActivityAt ? undefined : streak;
}

/** Whether to ping now; `inFlight` is a ping of this agent's still being answered. */
export function decideKeepWarm(
  settings: KeepWarmSettings,
  facts: KeepWarmFacts,
  streak: KeepWarmStreak | undefined,
  inFlight: boolean,
  now: number,
): KeepWarmDecision {
  const skip = (reason: KeepWarmSkip): KeepWarmDecision => ({ ping: false, skip: reason });
  if (!settings.enabled) return skip('disabled');
  if (!facts.taskOpen) return skip('closed');
  if (!facts.claudeTerminal) return skip('not_claude');
  if (!facts.processAlive) return skip('not_running');
  if (facts.coordinated) return skip('coordinated');
  if (!facts.hasConversation) return skip('no_conversation');
  if (inFlight) return skip('in_flight');
  if (facts.busy) return skip('busy');
  if (facts.needsUser) return skip('needs_user');
  if (facts.userInput) return skip('user_input');
  if (facts.pendingDelivery) return skip('pending_delivery');
  if (!facts.screenObserved || facts.lastActivityAt === undefined) return skip('no_idle_evidence');
  if (streak?.stopped) return skip('stopped');

  const intervalMs = clampKeepWarmIntervalMinutes(settings.intervalMinutes) * 60_000;
  const capMs = clampKeepWarmMaxHours(settings.maxHours) * 3_600_000;
  // Pings do not reset the cap: it counts from the first one after real activity.
  if (streak && now - streak.firstPingAt >= capMs) return skip('cap_reached');
  // A ping whose turn left no trace still counts as the last request.
  const quietSince = Math.max(facts.lastActivityAt, streak?.lastPingAt ?? 0);
  if (now - quietSince < intervalMs) return skip('not_idle_long_enough');
  return { ping: true };
}

/** The streak after sending a ping at `now`. */
export function recordKeepWarmPing(
  streak: KeepWarmStreak | undefined,
  now: number,
): KeepWarmStreak {
  return { firstPingAt: streak?.firstPingAt ?? now, lastPingAt: now };
}

/** The screen must be still this long after the ping's turn before it counts as
 *  over: Claude redraws its prompt and status line just after `Stop`. */
export const KEEP_WARM_SETTLE_MS = 5_000;
/** "ok" takes seconds; a ping still unanswered after this has gone wrong. */
export const KEEP_WARM_PING_TIMEOUT_MS = 3 * 60_000;

export interface KeepWarmFlightFacts {
  sentAt: number;
  processAlive: boolean;
  /** A question or menu appeared: end the ping so it shows, and stop pinging. */
  needsUser: boolean;
  busy: boolean;
  /** The agent's own hook report, when it has hooks. */
  hook: { state: 'working' | 'waiting' | 'done'; event: string; since: number } | null;
  lastOutputAt: number | undefined;
}

export type KeepWarmPingOutcome = 'running' | 'answered' | 'failed' | 'needs_user' | 'timed_out';

/** Where a ping's turn stands. Every outcome but `answered` stops the streak. */
export function keepWarmPingOutcome(flight: KeepWarmFlightFacts, now: number): KeepWarmPingOutcome {
  if (!flight.processAlive) return 'failed';
  if (flight.needsUser) return 'needs_user';
  const quiet =
    flight.lastOutputAt === undefined || now - flight.lastOutputAt >= KEEP_WARM_SETTLE_MS;
  const { hook } = flight;
  if (hook) {
    // Only a turn that ended after the ping was sent is the ping's.
    if (hook.state === 'done' && hook.since >= flight.sentAt) {
      if (hook.event === 'StopFailure') return 'failed';
      if (quiet) return 'answered';
    }
  } else if (!flight.busy && quiet && now - flight.sentAt >= KEEP_WARM_SETTLE_MS) {
    return 'answered';
  }
  return now - flight.sentAt >= KEEP_WARM_PING_TIMEOUT_MS ? 'timed_out' : 'running';
}
