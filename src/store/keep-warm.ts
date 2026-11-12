import { store } from './core';
import { sendPrompt } from './tasks';
import { composerInputBlocker, delegationStates } from './delegation';
import { getAgentHookStatus } from './agentHookStatus';
import { isAgentChat } from './agent-chat';
import { isAgentSuspended } from './agent-suspend';
import { isLandedTaskState } from './landing';
import { taskNeedsYou } from './sidebar-attention';
import {
  getAgentLastOutputAt,
  getAgentOutputTail,
  getTaskAttentionState,
  isAgentBlockedOnInput,
  isAgentIdle,
  isAutoTrustSettling,
  isClaudeAgent,
} from './taskStatus';
import {
  beginKeepWarmPing,
  endKeepWarmPing,
  forgetKeepWarmPing,
  getKeepWarmPing,
  isKeepWarmPingInFlight,
} from './keep-warm-flight';
import {
  KEEP_WARM_PROMPT,
  continueKeepWarmStreak,
  decideKeepWarm,
  keepWarmPingOutcome,
  recordKeepWarmPing,
  type KeepWarmFacts,
  type KeepWarmStreak,
} from './keep-warm-policy';
import { isScreenBlockingAutoSend } from '../components/prompt-autosend-readiness';
import { errMessage, info as logInfo, warn as logWarn } from '../lib/log';

/**
 * Keeps idle Claude Code conversations' prompt cache warm (Settings › Agents).
 * The rules live in `keep-warm-policy.ts`; this gathers the facts, sends the
 * pings through `sendPrompt`, and follows each one's turn until it ends, while
 * `keep-warm-flight.ts` hides that turn from task status and notifications.
 */

/** Often enough to end a ping's hidden turn soon after it settles. */
const TICK_MS = 5_000;

/** Pings since each agent's last real activity, by agent id. Session-only. */
const streaks = new Map<string, KeepWarmStreak>();

/** The agent's turn end as its hooks report it, else its last terminal output. */
function lastActivityAt(agentId: string): number | undefined {
  const hook = getAgentHookStatus(agentId);
  return hook?.state === 'done' ? hook.since : getAgentLastOutputAt(agentId);
}

function hasWaitingPeerMessage(agentId: string): boolean {
  return Object.values(delegationStates).some((state) =>
    state.messages.some(
      (message) => message.state === 'waiting' && message.recipient.agentId === agentId,
    ),
  );
}

function needsUser(taskId: string, agentId: string): boolean {
  const attention = getTaskAttentionState(taskId);
  return (
    isAgentBlockedOnInput(agentId) ||
    getAgentHookStatus(agentId)?.state === 'waiting' ||
    attention === 'needs_input' ||
    attention === 'error' ||
    attention === 'review' ||
    taskNeedsYou(taskId) ||
    isAutoTrustSettling(agentId) ||
    isScreenBlockingAutoSend(getAgentOutputTail(agentId))
  );
}

function keepWarmFacts(taskId: string, agentId: string, now: number): KeepWarmFacts {
  const task = store.tasks[taskId];
  const agent = store.agents[agentId];
  const hook = getAgentHookStatus(agentId);
  const lastOutputAt = getAgentLastOutputAt(agentId);
  const userInput =
    !!task &&
    (task.promptDraftActive === true ||
      !!task.promptDraft?.trim() ||
      !!task.prefillPrompt ||
      task.terminalInputPending === true ||
      (task.userActivityHoldUntil ?? 0) > now);
  const pendingDelivery =
    !!task &&
    (!!task.initialPrompt ||
      task.automationWriteInFlight === true ||
      !!task.stagedNotification ||
      hasWaitingPeerMessage(agentId) ||
      // Whatever else holds automatic input back holds a ping back too.
      composerInputBlocker(task, true, now) !== null);
  return {
    taskOpen:
      !!task &&
      store.taskOrder.includes(taskId) &&
      !task.collapsed &&
      !task.closingStatus &&
      !isLandedTaskState(task.landingState),
    claudeTerminal: !!agent && isClaudeAgent(agentId) && !isAgentChat(task, agentId),
    processAlive: agent?.status === 'running' && !isAgentSuspended(agent),
    coordinated: !!task?.coordinatedBy,
    hasConversation:
      (task?.promptedAgentIds?.includes(agentId) ?? false) ||
      (!!hook && hook.event !== 'SessionStart'),
    busy: !isAgentIdle(agentId),
    needsUser: needsUser(taskId, agentId),
    userInput,
    pendingDelivery,
    screenObserved: lastOutputAt !== undefined,
    lastActivityAt: lastActivityAt(agentId),
  };
}

/** Follow a ping's turn; once it ends, task status may show the agent again. */
function followPing(agentId: string, now: number): void {
  const streak = streaks.get(agentId);
  if (!streak) return;
  const ping = getKeepWarmPing(agentId);
  // Real activity forgot the ping (`forgetKeepWarmPing`), which ends the streak.
  if (!ping) {
    streaks.delete(agentId);
    return;
  }
  if (ping.endedAt !== undefined) return;
  const agent = store.agents[agentId];
  const hook = getAgentHookStatus(agentId);
  const outcome = keepWarmPingOutcome(
    {
      sentAt: ping.sentAt,
      processAlive: agent?.status === 'running',
      // Not the screen checks: a frame mid-redraw would read as a menu.
      needsUser: isAgentBlockedOnInput(agentId) || hook?.state === 'waiting',
      busy: !isAgentIdle(agentId),
      hook,
      lastOutputAt: getAgentLastOutputAt(agentId),
    },
    now,
  );
  if (outcome === 'running') return;
  endKeepWarmPing(agentId, now);
  streaks.set(agentId, {
    ...streak,
    settledActivityAt: lastActivityAt(agentId),
    stopped: outcome === 'answered' ? undefined : true,
  });
  if (outcome !== 'answered')
    logWarn('keep-warm', 'Ping did not end cleanly; no more pings until the task is used', {
      taskId: ping.taskId,
      agentId,
      outcome,
    });
}

async function sendPing(taskId: string, agentId: string, now: number): Promise<void> {
  const streak = recordKeepWarmPing(streaks.get(agentId), now);
  streaks.set(agentId, streak);
  beginKeepWarmPing(agentId, taskId, now);
  logInfo('keep-warm', 'Pinging an idle conversation to keep its prompt cache warm', {
    taskId,
    agentId,
  });
  try {
    await sendPrompt(taskId, agentId, KEEP_WARM_PROMPT, { appPrompt: true, keepWarm: true });
  } catch (error) {
    endKeepWarmPing(agentId);
    streaks.set(agentId, { ...streak, stopped: true, settledActivityAt: lastActivityAt(agentId) });
    logWarn('keep-warm', 'Could not send a keep-warm ping', {
      taskId,
      agentId,
      error: errMessage(error),
    });
  }
}

/** One pass over open tasks. Exported for tests. */
export function runKeepWarmTick(now = Date.now()): void {
  for (const agentId of [...streaks.keys()]) followPing(agentId, now);
  if (!store.keepWarmEnabled) {
    // Pings still in flight were followed above and end on their own.
    for (const agentId of [...streaks.keys()])
      if (!isKeepWarmPingInFlight(agentId)) streaks.delete(agentId);
    return;
  }
  const settings = {
    enabled: store.keepWarmEnabled,
    intervalMinutes: store.keepWarmIntervalMinutes,
    maxHours: store.keepWarmMaxHours,
  };
  const live = new Set<string>();
  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;
    // One ping per task at a time: its panes share the screen and the composer.
    if (task.agentIds.some(isKeepWarmPingInFlight)) {
      task.agentIds.forEach((id) => live.add(id));
      continue;
    }
    for (const agentId of task.agentIds) {
      live.add(agentId);
      const facts = keepWarmFacts(taskId, agentId, now);
      const streak = continueKeepWarmStreak(streaks.get(agentId), facts.lastActivityAt);
      if (streak) streaks.set(agentId, streak);
      else streaks.delete(agentId);
      const decision = decideKeepWarm(settings, facts, streak, false, now);
      if (!decision.ping) continue;
      void sendPing(taskId, agentId, now);
      break;
    }
  }
  for (const agentId of [...streaks.keys()]) {
    if (live.has(agentId) || isKeepWarmPingInFlight(agentId)) continue;
    streaks.delete(agentId);
    forgetKeepWarmPing(agentId);
  }
}

export function startKeepWarm(): () => void {
  const timer = setInterval(() => runKeepWarmTick(), TICK_MS);
  return () => {
    clearInterval(timer);
    streaks.clear();
  };
}

/** Test helper. */
export function resetKeepWarmStreaks(): void {
  streaks.clear();
}
