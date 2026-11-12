import { describe, expect, it } from 'vitest';
import {
  clampKeepWarmIntervalMinutes,
  clampKeepWarmMaxHours,
  continueKeepWarmStreak,
  decideKeepWarm,
  keepWarmPingOutcome,
  KEEP_WARM_PING_TIMEOUT_MS,
  KEEP_WARM_SETTLE_MS,
  recordKeepWarmPing,
  type KeepWarmFacts,
  type KeepWarmFlightFacts,
  type KeepWarmSettings,
  type KeepWarmSkip,
  type KeepWarmStreak,
} from './keep-warm-policy';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-12T08:00:00Z');

const settings: KeepWarmSettings = { enabled: true, intervalMinutes: 55, maxHours: 12 };

/** An open Claude Code task idle at its prompt since T0, nothing pending. */
function idleFacts(overrides: Partial<KeepWarmFacts> = {}): KeepWarmFacts {
  return {
    taskOpen: true,
    claudeTerminal: true,
    processAlive: true,
    coordinated: false,
    hasConversation: true,
    busy: false,
    needsUser: false,
    userInput: false,
    pendingDelivery: false,
    screenObserved: true,
    lastActivityAt: T0,
    ...overrides,
  };
}

function skipOf(
  facts: KeepWarmFacts,
  options: { streak?: KeepWarmStreak; inFlight?: boolean; now?: number; s?: KeepWarmSettings } = {},
): KeepWarmSkip | 'ping' {
  const decision = decideKeepWarm(
    options.s ?? settings,
    facts,
    options.streak,
    options.inFlight ?? false,
    options.now ?? T0 + 55 * MIN,
  );
  return decision.ping ? 'ping' : decision.skip;
}

describe('decideKeepWarm eligibility', () => {
  it('pings an open, idle Claude Code task once the interval has passed', () => {
    expect(skipOf(idleFacts())).toBe('ping');
  });

  it('does nothing while the setting is off', () => {
    expect(skipOf(idleFacts(), { s: { ...settings, enabled: false } })).toBe('disabled');
  });

  it.each<[string, Partial<KeepWarmFacts>, KeepWarmSkip]>([
    ['the task is closed, closing or archived', { taskOpen: false }, 'closed'],
    ['the agent is not Claude Code in a terminal', { claudeTerminal: false }, 'not_claude'],
    ["the agent's process is dead", { processAlive: false }, 'not_running'],
    ['a coordinator controls the task', { coordinated: true }, 'coordinated'],
    ['the session never had a turn', { hasConversation: false }, 'no_conversation'],
    ['the agent is busy', { busy: true }, 'busy'],
    ['the agent waits on the user (question, permission, menu)', { needsUser: true }, 'needs_user'],
    ['a draft sits in the prompt box or the user is typing', { userInput: true }, 'user_input'],
    [
      'a queued prompt or staged notification is pending',
      { pendingDelivery: true },
      'pending_delivery',
    ],
    ['no terminal shows the agent', { screenObserved: false }, 'no_idle_evidence'],
    [
      'nothing says when the agent was last active',
      { lastActivityAt: undefined },
      'no_idle_evidence',
    ],
  ])('never pings when %s', (_case, overrides, skip) => {
    expect(skipOf(idleFacts(overrides))).toBe(skip);
  });

  it('never sends a second ping while one is being answered', () => {
    expect(skipOf(idleFacts(), { inFlight: true })).toBe('in_flight');
  });

  it('puts the hard blockers before the timing, however long the task sat idle', () => {
    const longIdle = { now: T0 + 5 * HOUR };
    expect(skipOf(idleFacts({ needsUser: true }), longIdle)).toBe('needs_user');
    expect(skipOf(idleFacts({ userInput: true }), longIdle)).toBe('user_input');
    expect(skipOf(idleFacts({ coordinated: true }), longIdle)).toBe('coordinated');
  });

  it('stays quiet after a failed or unanswered ping until real activity', () => {
    const streak: KeepWarmStreak = { firstPingAt: T0, lastPingAt: T0, stopped: true };
    expect(skipOf(idleFacts(), { streak, now: T0 + 2 * HOUR })).toBe('stopped');
  });
});

describe('decideKeepWarm interval', () => {
  it('waits for the full interval of idleness', () => {
    expect(skipOf(idleFacts(), { now: T0 + 55 * MIN - 1 })).toBe('not_idle_long_enough');
    expect(skipOf(idleFacts(), { now: T0 + 55 * MIN })).toBe('ping');
  });

  it('follows a custom interval', () => {
    const s = { ...settings, intervalMinutes: 30 };
    expect(skipOf(idleFacts(), { s, now: T0 + 29 * MIN })).toBe('not_idle_long_enough');
    expect(skipOf(idleFacts(), { s, now: T0 + 30 * MIN })).toBe('ping');
  });

  it('never waits an hour or more, whatever the saved interval says', () => {
    const s = { ...settings, intervalMinutes: 90 };
    expect(skipOf(idleFacts(), { s, now: T0 + 59 * MIN })).toBe('ping');
  });

  it('counts from the last ping when its turn left no later activity', () => {
    const streak: KeepWarmStreak = {
      firstPingAt: T0 + 55 * MIN,
      lastPingAt: T0 + 55 * MIN,
      settledActivityAt: T0,
    };
    expect(skipOf(idleFacts(), { streak, now: T0 + 109 * MIN })).toBe('not_idle_long_enough');
    expect(skipOf(idleFacts(), { streak, now: T0 + 110 * MIN })).toBe('ping');
  });

  it("counts from the ping's own turn end when it reported one", () => {
    const pingTurnEnd = T0 + 56 * MIN;
    const streak: KeepWarmStreak = {
      firstPingAt: T0 + 55 * MIN,
      lastPingAt: T0 + 55 * MIN,
      settledActivityAt: pingTurnEnd,
    };
    const facts = idleFacts({ lastActivityAt: pingTurnEnd });
    expect(skipOf(facts, { streak, now: pingTurnEnd + 55 * MIN - 1 })).toBe('not_idle_long_enough');
    expect(skipOf(facts, { streak, now: pingTurnEnd + 55 * MIN })).toBe('ping');
  });
});

describe('decideKeepWarm cap', () => {
  it('pings for the cap after the first ping, then leaves the task to go cold', () => {
    const firstPingAt = T0 + 55 * MIN;
    const lastPingAt = firstPingAt + 11 * HOUR;
    const streak: KeepWarmStreak = { firstPingAt, lastPingAt, settledActivityAt: lastPingAt };
    const facts = idleFacts({ lastActivityAt: lastPingAt });
    expect(skipOf(facts, { streak, now: lastPingAt + 55 * MIN - 1 })).toBe('not_idle_long_enough');
    // 11 h 55 min after the first ping: still inside the cap.
    expect(skipOf(facts, { streak, now: lastPingAt + 55 * MIN })).toBe('ping');
    // The next one would be due at 12 h 50 min.
    expect(skipOf(facts, { streak, now: lastPingAt + 110 * MIN })).toBe('cap_reached');
    expect(skipOf(facts, { streak, now: firstPingAt + 12 * HOUR })).toBe('cap_reached');
    expect(skipOf(facts, { streak, now: firstPingAt + 20 * HOUR })).toBe('cap_reached');
  });

  it('follows a custom cap', () => {
    const streak: KeepWarmStreak = { firstPingAt: T0, lastPingAt: T0, settledActivityAt: T0 };
    const s = { ...settings, maxHours: 2 };
    expect(skipOf(idleFacts(), { streak, s, now: T0 + 2 * HOUR - 1 })).toBe('ping');
    expect(skipOf(idleFacts(), { streak, s, now: T0 + 2 * HOUR })).toBe('cap_reached');
  });

  it('does not let pings reset the cap', () => {
    let streak: KeepWarmStreak | undefined;
    let now = T0 + 55 * MIN;
    const sent: number[] = [];
    // Each ping's turn ends a few seconds after it is sent and reports that end.
    while (now < T0 + 24 * HOUR) {
      const turnEnd = streak?.settledActivityAt ?? T0;
      const facts = idleFacts({ lastActivityAt: turnEnd });
      streak = continueKeepWarmStreak(streak, facts.lastActivityAt);
      if (decideKeepWarm(settings, facts, streak, false, now).ping) {
        sent.push(now);
        streak = { ...recordKeepWarmPing(streak, now), settledActivityAt: now + 5_000 };
      }
      now += MIN;
    }
    expect(sent[0]).toBe(T0 + 55 * MIN);
    expect((sent.at(-1) ?? 0) - sent[0]).toBeLessThan(12 * HOUR);
    // Every gap stays under the hour the cache lasts.
    for (let i = 1; i < sent.length; i++) expect(sent[i] - sent[i - 1]).toBeLessThan(HOUR);
    expect(sent.length).toBe(13);
  });

  it('starts a fresh cap once the task sees real activity', () => {
    const streak: KeepWarmStreak = {
      firstPingAt: T0,
      lastPingAt: T0 + 11 * HOUR,
      settledActivityAt: T0 + 11 * HOUR,
    };
    // The user came back for a turn of their own, then left again.
    const userTurnEnd = T0 + 11.5 * HOUR;
    const next = continueKeepWarmStreak(streak, userTurnEnd);
    expect(next).toBeUndefined();
    expect(
      skipOf(idleFacts({ lastActivityAt: userTurnEnd }), {
        streak: next,
        now: userTurnEnd + 55 * MIN,
      }),
    ).toBe('ping');
  });
});

describe('continueKeepWarmStreak', () => {
  const streak: KeepWarmStreak = { firstPingAt: T0, lastPingAt: T0, settledActivityAt: T0 + 5_000 };

  it('keeps the streak while nothing happened after the ping settled', () => {
    expect(continueKeepWarmStreak(streak, T0 + 5_000)).toBe(streak);
  });

  it('ends the streak on activity after the ping settled', () => {
    expect(continueKeepWarmStreak(streak, T0 + 5_001)).toBeUndefined();
  });

  it('cannot judge a ping still in flight', () => {
    const inFlight: KeepWarmStreak = { firstPingAt: T0, lastPingAt: T0 };
    expect(continueKeepWarmStreak(inFlight, T0 + HOUR)).toBe(inFlight);
  });

  it('starts a streak at the first ping and keeps its start afterwards', () => {
    const first = recordKeepWarmPing(undefined, T0);
    expect(first).toEqual({ firstPingAt: T0, lastPingAt: T0 });
    const second = recordKeepWarmPing(
      { ...first, settledActivityAt: T0 + 1, stopped: true },
      T0 + HOUR,
    );
    expect(second).toEqual({ firstPingAt: T0, lastPingAt: T0 + HOUR });
  });
});

describe('keepWarmPingOutcome', () => {
  const sentAt = T0;
  function flight(overrides: Partial<KeepWarmFlightFacts> = {}): KeepWarmFlightFacts {
    return {
      sentAt,
      processAlive: true,
      needsUser: false,
      busy: false,
      hook: { state: 'done', event: 'Stop', since: sentAt + 3_000 },
      lastOutputAt: sentAt + 3_000,
      ...overrides,
    };
  }

  it("is answered once the ping's Stop came in and the screen went quiet", () => {
    expect(keepWarmPingOutcome(flight(), sentAt + 3_000 + KEEP_WARM_SETTLE_MS)).toBe('answered');
  });

  it('keeps running while the prompt and status line still redraw after Stop', () => {
    expect(keepWarmPingOutcome(flight(), sentAt + 3_000 + KEEP_WARM_SETTLE_MS - 1)).toBe('running');
  });

  it('does not take the turn before the ping for its answer', () => {
    const before = flight({ hook: { state: 'done', event: 'Stop', since: sentAt - HOUR } });
    expect(keepWarmPingOutcome(before, sentAt + 30_000)).toBe('running');
    expect(keepWarmPingOutcome(before, sentAt + KEEP_WARM_PING_TIMEOUT_MS)).toBe('timed_out');
  });

  it('keeps running while the hook reports the turn', () => {
    const working = flight({ hook: { state: 'working', event: 'PreToolUse', since: sentAt + 1 } });
    expect(keepWarmPingOutcome(working, sentAt + 60_000)).toBe('running');
  });

  it('fails when the turn fails or the process dies', () => {
    const failed = flight({ hook: { state: 'done', event: 'StopFailure', since: sentAt + 1 } });
    expect(keepWarmPingOutcome(failed, sentAt + 2_000)).toBe('failed');
    expect(keepWarmPingOutcome(flight({ processAlive: false }), sentAt + 1)).toBe('failed');
  });

  it('ends at once when the ping raised a question, so it shows', () => {
    expect(keepWarmPingOutcome(flight({ needsUser: true }), sentAt + 1)).toBe('needs_user');
  });

  it('falls back to terminal activity without hooks', () => {
    const noHook = flight({ hook: null });
    expect(keepWarmPingOutcome({ ...noHook, busy: true }, sentAt + 60_000)).toBe('running');
    expect(keepWarmPingOutcome(noHook, sentAt + 3_000 + KEEP_WARM_SETTLE_MS)).toBe('answered');
  });
});

describe('setting bounds', () => {
  it('keeps the interval under the hour the cache lasts', () => {
    expect(clampKeepWarmIntervalMinutes(55)).toBe(55);
    expect(clampKeepWarmIntervalMinutes(60)).toBe(59);
    expect(clampKeepWarmIntervalMinutes(1)).toBe(5);
    expect(clampKeepWarmIntervalMinutes(Number.NaN)).toBe(55);
  });

  it('bounds the cap', () => {
    expect(clampKeepWarmMaxHours(12)).toBe(12);
    expect(clampKeepWarmMaxHours(0)).toBe(1);
    expect(clampKeepWarmMaxHours(100)).toBe(24);
    expect(clampKeepWarmMaxHours(Number.NaN)).toBe(12);
  });
});
