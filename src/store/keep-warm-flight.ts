import { createSignal } from 'solid-js';

/**
 * Which agents are answering a keep-warm ping (see `keep-warm.ts`). Kept free of
 * store imports so the status modules can read it: a ping's turn must not count
 * as activity, so task attention, unread state and turn-failure errors skip it.
 */

/** Hook events of the ping's turn can trail its end by a moment, e.g. a `Stop`
 *  reported after the screen already settled. */
const LATE_EVENT_GRACE_MS = 10_000;

interface KeepWarmPing {
  taskId: string;
  sentAt: number;
  /** When the ping's turn was seen to end; unset while it runs. */
  endedAt?: number;
}

const [pings, setPings] = createSignal<ReadonlyMap<string, KeepWarmPing>>(new Map());

export function beginKeepWarmPing(agentId: string, taskId: string, now = Date.now()): void {
  setPings((prev) => new Map(prev).set(agentId, { taskId, sentAt: now }));
}

export function endKeepWarmPing(agentId: string, now = Date.now()): void {
  const ping = pings().get(agentId);
  if (!ping || ping.endedAt !== undefined) return;
  setPings((prev) => new Map(prev).set(agentId, { ...ping, endedAt: now }));
}

/** Real activity: whatever the agent does next is the user's again, not a ping's. */
export function forgetKeepWarmPing(agentId: string): void {
  if (!pings().has(agentId)) return;
  setPings((prev) => {
    const next = new Map(prev);
    next.delete(agentId);
    return next;
  });
}

/** The agent is answering a keep-warm ping right now. Reactive. */
export function isKeepWarmPingInFlight(agentId: string): boolean {
  const ping = pings().get(agentId);
  return ping !== undefined && ping.endedAt === undefined;
}

export function getKeepWarmPing(agentId: string): Readonly<KeepWarmPing> | undefined {
  return pings().get(agentId);
}

/** Whether something the agent reported at `at` belongs to a ping's turn. */
export function isKeepWarmTurnAt(agentId: string, at: number): boolean {
  const ping = pings().get(agentId);
  if (!ping || at < ping.sentAt) return false;
  return ping.endedAt === undefined || at <= ping.endedAt + LATE_EVENT_GRACE_MS;
}

/** When the task's conversation was last kept warm, for a discreet hint. Reactive. */
export function getTaskKeptWarmAt(taskId: string): number | undefined {
  let latest: number | undefined;
  for (const ping of pings().values()) {
    if (ping.taskId !== taskId || ping.endedAt === undefined) continue;
    if (latest === undefined || ping.sentAt > latest) latest = ping.sentAt;
  }
  return latest;
}

/** Test helper. */
export function resetKeepWarmPings(): void {
  setPings(new Map());
}
