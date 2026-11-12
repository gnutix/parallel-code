import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';
import type { AgentHookStatus } from './agentHookStatus';
import type { TaskAttentionState } from './taskStatus';

type MockStore = {
  keepWarmEnabled: boolean;
  keepWarmIntervalMinutes: number;
  keepWarmMaxHours: number;
  taskOrder: string[];
  tasks: Record<string, Record<string, unknown>>;
  agents: Record<string, Record<string, unknown>>;
};

const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<MockStore> | undefined,
}));
vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness<MockStore>({
    keepWarmEnabled: true,
    keepWarmIntervalMinutes: 55,
    keepWarmMaxHours: 12,
    taskOrder: [],
    tasks: {},
    agents: {},
  });
  return core.harness.moduleMock();
});

vi.mock('solid-js', () => ({
  createSignal<T>(initial: T): [() => T, (v: T | ((prev: T) => T)) => void] {
    let value = initial;
    return [
      () => value,
      (v) => {
        value = typeof v === 'function' ? (v as (prev: T) => T)(value) : v;
      },
    ];
  },
}));

const tasks = vi.hoisted(() => ({ sendPrompt: vi.fn() }));
vi.mock('./tasks', () => tasks);

const delegation = vi.hoisted(() => ({
  delegationStates: {} as Record<string, { messages: unknown[] }>,
  composerInputBlocker: vi.fn((): string | null => null),
}));
vi.mock('./delegation', () => delegation);

const hooks = vi.hoisted(() => ({ statuses: new Map<string, Partial<AgentHookStatus>>() }));
vi.mock('./agentHookStatus', () => ({
  getAgentHookStatus: (agentId: string) => hooks.statuses.get(agentId) ?? null,
}));

const status = vi.hoisted(() => ({
  lastOutputAt: new Map<string, number>(),
  attention: 'idle' as TaskAttentionState,
  blocked: false,
  idle: true,
  autoTrust: false,
  claude: true,
  needsYou: false,
  screenBlocked: false,
  chat: false,
}));
vi.mock('./taskStatus', () => ({
  getAgentLastOutputAt: (agentId: string) => status.lastOutputAt.get(agentId),
  getAgentOutputTail: () => '',
  getTaskAttentionState: () => status.attention,
  isAgentBlockedOnInput: () => status.blocked,
  isAgentIdle: () => status.idle,
  isAutoTrustSettling: () => status.autoTrust,
  isClaudeAgent: () => status.claude,
}));
vi.mock('./sidebar-attention', () => ({ taskNeedsYou: () => status.needsYou }));
vi.mock('../components/prompt-autosend-readiness', () => ({
  isScreenBlockingAutoSend: () => status.screenBlocked,
}));
vi.mock('./agent-chat', () => ({ isAgentChat: () => status.chat }));

const { runKeepWarmTick, resetKeepWarmStreaks } = await import('./keep-warm');
const { KEEP_WARM_PROMPT } = await import('./keep-warm-policy');
const { forgetKeepWarmPing, getTaskKeptWarmAt, isKeepWarmPingInFlight, resetKeepWarmPings } =
  await import('./keep-warm-flight');

const MIN = 60_000;
const T0 = Date.parse('2026-11-12T08:00:00Z');

function store(): MockStore {
  return expectDefined(core.harness, 'mock store harness').state();
}

/** The agent's turn ended at `at` and the screen has been quiet since. */
function turnEnded(at: number, event = 'Stop'): void {
  hooks.statuses.set('agent-1', { state: 'done', event, since: at, updatedAt: at });
  status.lastOutputAt.set('agent-1', at);
}

function pinged(): number {
  return tasks.sendPrompt.mock.calls.length;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const harness = expectDefined(core.harness, 'mock store harness');
  harness.reset({
    keepWarmEnabled: true,
    keepWarmIntervalMinutes: 55,
    keepWarmMaxHours: 12,
    taskOrder: ['task-1'],
    tasks: {
      'task-1': {
        id: 'task-1',
        agentIds: ['agent-1'],
        shellAgentIds: [],
        promptedAgentIds: ['agent-1'],
      },
    },
    agents: {
      'agent-1': { id: 'agent-1', taskId: 'task-1', status: 'running', signal: null },
    },
  });
  tasks.sendPrompt.mockReset().mockResolvedValue(undefined);
  delegation.composerInputBlocker.mockReset().mockReturnValue(null);
  for (const key of Object.keys(delegation.delegationStates))
    delete delegation.delegationStates[key];
  hooks.statuses.clear();
  status.lastOutputAt.clear();
  Object.assign(status, {
    attention: 'idle',
    blocked: false,
    idle: true,
    autoTrust: false,
    claude: true,
    needsYou: false,
    screenBlocked: false,
    chat: false,
  });
  resetKeepWarmStreaks();
  resetKeepWarmPings();
  turnEnded(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runKeepWarmTick', () => {
  it('sends the ping through the normal prompt path once the task sat idle for the interval', () => {
    runKeepWarmTick(T0 + 55 * MIN - 1);
    expect(pinged()).toBe(0);

    runKeepWarmTick(T0 + 55 * MIN);
    expect(tasks.sendPrompt).toHaveBeenCalledWith('task-1', 'agent-1', KEEP_WARM_PROMPT, {
      appPrompt: true,
      keepWarm: true,
    });
    expect(isKeepWarmPingInFlight('agent-1')).toBe(true);
  });

  it('does nothing while the setting is off', () => {
    store().keepWarmEnabled = false;
    runKeepWarmTick(T0 + 5 * 60 * MIN);
    expect(pinged()).toBe(0);
  });

  it.each<[string, () => void]>([
    ['the task is archived', () => (store().tasks['task-1'].collapsed = true)],
    ['the task is closing', () => (store().tasks['task-1'].closingStatus = 'closing')],
    ['the task is not in the task list', () => (store().taskOrder = [])],
    ['the task has landed', () => (store().tasks['task-1'].landingState = 'reviewed')],
    ['the agent is not Claude Code', () => (status.claude = false)],
    ['the task shows the chat view', () => (status.chat = true)],
    ["the agent's process is dead", () => (store().agents['agent-1'].status = 'exited')],
    ['a coordinator controls the task', () => (store().tasks['task-1'].coordinatedBy = 'lead')],
    [
      'the session never had a turn',
      () => {
        store().tasks['task-1'].promptedAgentIds = undefined;
        hooks.statuses.set('agent-1', { state: 'done', event: 'SessionStart', since: T0 });
      },
    ],
    ['the agent is busy', () => (status.idle = false)],
    ['the agent asks a question', () => (status.blocked = true)],
    [
      'a permission prompt waits',
      () => hooks.statuses.set('agent-1', { state: 'waiting', event: 'PermissionRequest' }),
    ],
    ['the task needs input', () => (status.attention = 'needs_input')],
    ['the task reports an error', () => (status.attention = 'error')],
    ['the task waits for review', () => (status.attention = 'review')],
    ['the task is in Needs you', () => (status.needsYou = true)],
    ['a menu is on screen', () => (status.screenBlocked = true)],
    ['a trust dialog is being accepted', () => (status.autoTrust = true)],
    [
      'the prompt box holds a draft',
      () => (store().tasks['task-1'].promptDraft = 'half a thought'),
    ],
    ['the prompt box is in use', () => (store().tasks['task-1'].promptDraftActive = true)],
    ['a prompt is prefilled', () => (store().tasks['task-1'].prefillPrompt = 'Fix the CI')],
    ['the terminal holds typed input', () => (store().tasks['task-1'].terminalInputPending = true)],
    [
      'the user is typing',
      () => (store().tasks['task-1'].userActivityHoldUntil = T0 + 5 * 60 * MIN + 1),
    ],
    ["the task's own prompt is queued", () => (store().tasks['task-1'].initialPrompt = 'Start')],
    [
      'a staged notification is pending',
      () =>
        (store().tasks['task-1'].stagedNotification = {
          batchId: 'b',
          notificationIds: ['n'],
          text: 'Child done',
          autoFireAt: 0,
          userEdited: false,
        }),
    ],
    [
      'a peer message waits for the agent',
      () =>
        (delegation.delegationStates['lead'] = {
          messages: [{ state: 'waiting', recipient: { taskId: 'task-1', agentId: 'agent-1' } }],
        }),
    ],
    [
      'another automatic message is being written',
      () => (store().tasks['task-1'].automationWriteInFlight = true),
    ],
    [
      'anything else holds automatic input back',
      () => delegation.composerInputBlocker.mockReturnValue('Something new'),
    ],
    ['no terminal shows the agent', () => status.lastOutputAt.clear()],
  ])('never pings when %s', (_case, arrange) => {
    arrange();
    runKeepWarmTick(T0 + 5 * 60 * MIN);
    expect(pinged()).toBe(0);
  });

  it("follows the ping's turn, then pings again an interval after it", async () => {
    const sentAt = T0 + 55 * MIN;
    runKeepWarmTick(sentAt);
    await Promise.resolve();
    expect(pinged()).toBe(1);

    // Claude answers "ok"; the prompt and status line still redraw just after Stop.
    turnEnded(sentAt + 3_000);
    runKeepWarmTick(sentAt + 4_000);
    expect(isKeepWarmPingInFlight('agent-1')).toBe(true);
    runKeepWarmTick(sentAt + 8_000);
    expect(isKeepWarmPingInFlight('agent-1')).toBe(false);
    expect(getTaskKeptWarmAt('task-1')).toBe(sentAt);

    runKeepWarmTick(sentAt + 3_000 + 55 * MIN - 1);
    expect(pinged()).toBe(1);
    runKeepWarmTick(sentAt + 3_000 + 55 * MIN);
    expect(pinged()).toBe(2);
  });

  it('stops pinging after a failed ping until the task is used again', () => {
    const sentAt = T0 + 55 * MIN;
    runKeepWarmTick(sentAt);
    turnEnded(sentAt + 3_000, 'StopFailure');
    runKeepWarmTick(sentAt + 10_000);
    expect(isKeepWarmPingInFlight('agent-1')).toBe(false);

    runKeepWarmTick(sentAt + 3 * 60 * MIN);
    expect(pinged()).toBe(1);

    // The user sends a prompt (sendPrompt forgets the ping) and leaves again.
    forgetKeepWarmPing('agent-1');
    const userTurnEnd = sentAt + 4 * 60 * MIN;
    turnEnded(userTurnEnd);
    runKeepWarmTick(userTurnEnd + 55 * MIN);
    expect(pinged()).toBe(2);
  });

  it('stops pinging when sending fails', async () => {
    tasks.sendPrompt.mockRejectedValueOnce(new Error('Agent not found'));
    runKeepWarmTick(T0 + 55 * MIN);
    await vi.waitFor(() => expect(isKeepWarmPingInFlight('agent-1')).toBe(false));
    runKeepWarmTick(T0 + 3 * 60 * MIN);
    expect(pinged()).toBe(1);
  });

  it('leaves the task to go cold after the cap of pings without real activity', () => {
    let now = T0 + 55 * MIN;
    for (let i = 0; i < 24 * 60; i++, now += MIN) {
      runKeepWarmTick(now);
      // Each ping is answered within seconds, before the next tick.
      if (isKeepWarmPingInFlight('agent-1')) {
        turnEnded(now + 2_000);
        runKeepWarmTick(now + 10_000);
      }
    }
    const sends = tasks.sendPrompt.mock.calls.length;
    expect(sends).toBeGreaterThan(10);
    expect(sends).toBeLessThan(15);
  });
});
