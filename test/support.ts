import { Key, type KeyId, matchesKey } from "@earendil-works/pi-tui";

type MockHandler = (...args: unknown[]) => unknown;

type MockCommand = {
  description?: string;
  handler: MockHandler;
  getArgumentCompletions?: (prefix: string) => unknown;
};

type MockPiApi = {
  registerCommand(name: string, command: unknown): void;
  registerProvider(name: string, config: unknown): void;
  unregisterProvider(name: string): void;
  on(name: string, handler: MockHandler): void;
  events: {
    emit: (channel: string, data: unknown) => void;
    on: (channel: string, handler: (data: unknown) => void) => () => void;
    clear: () => void;
  };
  appendEntry(customType: string, data: unknown): void;
  setModel(model: unknown): Promise<boolean>;
};

export function createMockPi() {
  const commands = new Map<string, MockCommand>();
  const events = new Map<string, MockHandler[]>();
  const providers = new Map<string, unknown>();
  const providerRegistrations: Array<{ name: string; config: unknown }> = [];
  const providerUnregistrations: string[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const setModels: unknown[] = [];
  const eventBusSubscriptions = new Map<string, Array<(data: unknown) => void>>();
  const eventBus = {
    emit(channel: string, data: unknown) {
      for (const handler of eventBusSubscriptions.get(channel) ?? []) {
        try {
          const result = handler(data);
          void Promise.resolve(result).catch(() => undefined);
        } catch {
          // Match Pi's event bus: one observer cannot interrupt sibling handlers.
        }
      }
    },
    on(channel: string, handler: (data: unknown) => void) {
      const list = eventBusSubscriptions.get(channel) ?? [];
      list.push(handler);
      eventBusSubscriptions.set(channel, list);
      return () => {
        const current = eventBusSubscriptions.get(channel);
        if (!current) return;
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    clear() {
      eventBusSubscriptions.clear();
    },
  };
  const rawPi: MockPiApi = {
    registerCommand(name: string, command: unknown) {
      commands.set(name, command as MockCommand);
    },
    registerProvider(name: string, config: unknown) {
      const previous = providers.get(name);
      const effective =
        previous &&
        typeof previous === "object" &&
        !Array.isArray(previous) &&
        config &&
        typeof config === "object" &&
        !Array.isArray(config)
          ? { ...previous, ...config }
          : config;
      providers.set(name, effective);
      providerRegistrations.push({ name, config });
    },
    unregisterProvider(name: string) {
      providers.delete(name);
      providerUnregistrations.push(name);
    },
    on(name: string, handler: MockHandler) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    async setModel(model: unknown) {
      setModels.push(model);
      return true;
    },
    events: eventBus,
  };

  return {
    pi: rawPi as never,
    rawPi,
    commands,
    events,
    eventBus,
    providers,
    providerRegistrations,
    providerUnregistrations,
    entries,
    setModels,
  };
}

export function createMockContext(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const selectOverride = overrides.select as
    | ((title: string, options: string[]) => Promise<string | undefined>)
    | undefined;
  const inputOverride = overrides.input as ((title: string, placeholder?: string) => Promise<unknown>) | undefined;
  const defaultCustom = async (factory: unknown) => {
    if (!selectOverride) return undefined;
    const harness = createCustomSelectorHarness(factory, 100);
    const options: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      const selected = selectedRow(harness.render());
      if (!selected || options.includes(selected)) break;
      options.push(selected);
      harness.handleInput("tui.select.down");
    }
    for (let index = 0; index < options.length; index += 1) {
      harness.handleInput("tui.select.up");
    }
    if (options.length === 0 && harness.isFocusable && inputOverride) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await inputOverride(harness.render().join("\n"), "");
        if (isRecord(response) && response.kind === "closed") {
          harness.handleInput("\u0003");
          return harness.result;
        }
        if (response === undefined || (isRecord(response) && response.kind === "cancelled")) {
          harness.handleInput("tui.select.cancel");
          return harness.result;
        }
        const value = isRecord(response) && response.kind === "submitted" ? response.value : response;
        if (typeof value !== "string") throw new Error("Mock input must return a string or exit");
        harness.setFocused(true);
        if (attempt > 0) harness.handleInput("\u0015");
        harness.handleInput(value);
        harness.handleInput("tui.input.submit");
        await harness.waitForPending();
        if (harness.result !== undefined) return harness.result;
      }
      throw new Error("Mock input exceeded its retry limit");
    }
    const selected = await selectOverride(harness.render().join("\n"), options);
    if (selected === "\u0003") {
      harness.handleInput("\u0003");
      return harness.result;
    }
    if (selected === undefined) {
      harness.handleInput("tui.select.cancel");
      return harness.result;
    }
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option === selected || option.startsWith(selected) || selected.startsWith(option)),
    );
    for (let index = 0; index < selectedIndex; index += 1) {
      harness.handleInput("tui.select.down");
    }
    harness.handleInput("tui.select.confirm");
    if (harness.result !== undefined) return harness.result;
    await harness.waitForPending();
    await Promise.resolve();
    if (harness.result !== undefined) return harness.result;
    harness.handleInput("tui.select.cancel");
    return harness.result;
  };
  const custom =
    (overrides.custom as ((factory: unknown, options?: unknown) => Promise<unknown>) | undefined) ?? defaultCustom;

  const ctx = {
    cwd: overrides.cwd ?? process.cwd(),
    mode: overrides.mode ?? (overrides.hasUI ? "tui" : undefined),
    hasUI: overrides.hasUI ?? (overrides.mode === "tui" || overrides.mode === "rpc"),
    model: overrides.model,
    scopedModels: overrides.scopedModels ?? [],
    ui: {
      theme: overrides.theme ?? { fg: (_role: string, text: string) => text },
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.set(key, value);
      },
      confirm: overrides.confirm ?? (async () => true),
      input: overrides.input ?? (async () => undefined),
      select: overrides.select ?? (async () => undefined),
      custom,
    },
    isIdle: overrides.isIdle ?? (() => true),
    abort: overrides.abort ?? (() => undefined),
    sessionManager: overrides.sessionManager ?? {
      getSessionId: () => "test-session",
      getSessionName: () => undefined,
      getBranch: () => [],
      getEntries: () => [],
    },
    modelRegistry: overrides.modelRegistry ?? {
      getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
      getAvailable: () => [],
      getAll: () => [],
      isUsingOAuth: () => false,
    },
    ...overrides,
  };

  return {
    ctx: ctx as never,
    notifications,
    statuses,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectedRow(lines: readonly string[]): string | undefined {
  const line = lines.find((candidate) => candidate.startsWith("→ ") || candidate.startsWith("› "));
  if (!line) return undefined;
  return line
    .slice(2)
    .replace(/^\[(?:x| |-)\]\s+/u, "")
    .split(/\s{2,}/u)[0]
    ?.trim();
}

export function createCustomSelectorHarness(
  factory: unknown,
  width = 100,
  keybindingsOverride?: {
    matches(data: string, key: string): boolean;
    getKeys(key: string): readonly string[];
  },
  terminalRows = 24,
) {
  if (typeof factory !== "function") throw new Error("Expected a custom component factory");
  let result: unknown;
  let resolveResult!: (value: unknown) => void;
  const resultPromise = new Promise<unknown>((resolve) => {
    resolveResult = resolve;
  });
  const terminal = { rows: terminalRows };
  const component = (
    factory as (...args: unknown[]) => {
      render(width: number): string[];
      handleInput(data: string): void;
    }
  )(
    { terminal, requestRender() {} },
    {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    },
    keybindingsOverride ?? {
      matches(data: string, key: string) {
        const bindings: Record<string, KeyId> = {
          "tui.select.up": Key.up,
          "tui.select.down": Key.down,
          "tui.select.pageUp": Key.pageUp,
          "tui.select.pageDown": Key.pageDown,
          "tui.select.confirm": Key.enter,
          "tui.select.cancel": Key.escape,
          "tui.input.submit": Key.enter,
        };
        const binding = bindings[key];
        return (
          (binding !== undefined && matchesKey(data, binding)) ||
          (key === "tui.select.cancel" && matchesKey(data, Key.ctrl("c")))
        );
      },
      getKeys(key: string): readonly string[] {
        if (key === "tui.select.up") return ["up"];
        if (key === "tui.select.down") return ["down"];
        if (key === "tui.select.confirm" || key === "tui.input.submit") return ["enter"];
        if (key === "tui.select.cancel") return ["escape", "ctrl+c"];
        return [];
      },
    },
    (value: unknown) => {
      result = value;
      resolveResult(value);
    },
  );
  return {
    handleInput(data: string) {
      const inputData: Record<string, string> = {
        "tui.select.up": "\u001b[A",
        "tui.select.down": "\u001b[B",
        "tui.select.pageUp": "\u001b[5~",
        "tui.select.pageDown": "\u001b[6~",
        "tui.select.confirm": "\r",
        "tui.select.cancel": "\u001b",
        "tui.input.submit": "\r",
      };
      component.handleInput(inputData[data] ?? data);
      return component.render(width);
    },
    render(renderWidth = width) {
      return component.render(renderWidth);
    },
    setTerminalRows(rows: number) {
      terminal.rows = rows;
    },
    invalidate() {
      (component as { invalidate?: () => void }).invalidate?.();
    },
    setFocused(focused: boolean) {
      if ("focused" in component) (component as { focused: boolean }).focused = focused;
    },
    async waitForPending() {
      await (component as { waitForPending?: () => Promise<void> }).waitForPending?.();
    },
    dispose() {
      (component as { dispose?: () => void }).dispose?.();
    },
    resultPromise,
    get isFocusable() {
      return "focused" in component;
    },
    get result() {
      return result;
    },
  };
}
