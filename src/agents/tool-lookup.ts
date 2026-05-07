/**
 * Deferred-tool meta-tool (`tool_lookup`).
 *
 * When `agents.<id>.tools.hot` is configured, only hot tools are sent in the
 * per-turn API tools array. Cold tools (every registered tool not in the hot
 * list, except `tool_lookup` itself) are deferred — their schemas are absent
 * from the request payload, saving tokens.
 *
 * The agent regains access to a cold tool by calling `tool_lookup({ name })`.
 * The meta-tool returns the named tool's schema as its response payload AND
 * records an unlock for the current session. From that turn forward, the
 * unlocked tool's full schema is included in the per-turn tools array until
 * `tools.coldUnlockTtlTurns` turns have elapsed without a fresh unlock.
 *
 * State is in-process; restart resets all unlocks (intentional — a restart is
 * a fresh start). Sessions are isolated by `sessionKey`.
 */

import type { AnyAgentTool } from "./tools/common.js";

type UnlockEntry = { lastSeenTurn: number };

const UNLOCKED_BY_SESSION: Map<string, Map<string, UnlockEntry>> = new Map();
const TURN_COUNTER_BY_SESSION: Map<string, number> = new Map();
const COLD_TOOL_INDEX_BY_SESSION: Map<string, string> = new Map();

export function setColdToolIndexForSession(sessionKey: string, indexText: string): void {
  if (indexText && indexText.trim()) {
    COLD_TOOL_INDEX_BY_SESSION.set(sessionKey, indexText);
  } else {
    COLD_TOOL_INDEX_BY_SESSION.delete(sessionKey);
  }
}

export function getColdToolIndexForSession(sessionKey: string): string {
  return COLD_TOOL_INDEX_BY_SESSION.get(sessionKey) ?? "";
}

export function bumpSessionTurn(sessionKey: string): number {
  const next = (TURN_COUNTER_BY_SESSION.get(sessionKey) ?? 0) + 1;
  TURN_COUNTER_BY_SESSION.set(sessionKey, next);
  return next;
}

export function getActiveUnlockedTools(
  sessionKey: string,
  currentTurn: number,
  ttlTurns: number,
): Set<string> {
  const map = UNLOCKED_BY_SESSION.get(sessionKey);
  if (!map || map.size === 0) {
    return new Set();
  }
  const active = new Set<string>();
  for (const [name, entry] of map.entries()) {
    if (currentTurn - entry.lastSeenTurn <= ttlTurns) {
      active.add(name);
    } else {
      map.delete(name);
    }
  }
  return active;
}

function recordUnlock(sessionKey: string, toolName: string, atTurn: number): void {
  const map = UNLOCKED_BY_SESSION.get(sessionKey) ?? new Map<string, UnlockEntry>();
  map.set(toolName, { lastSeenTurn: atTurn });
  UNLOCKED_BY_SESSION.set(sessionKey, map);
}

/**
 * Refresh an unlocked tool's lastSeenTurn so that "TTL of N turns of non-use"
 * doesn't drop tools that the agent is actively using. Called by a wrapper
 * around each unlocked cold tool's execute() when it actually runs.
 */
export function touchUnlockedTool(
  sessionKey: string,
  toolName: string,
  atTurn: number,
): void {
  const map = UNLOCKED_BY_SESSION.get(sessionKey);
  if (map && map.has(toolName)) {
    map.set(toolName, { lastSeenTurn: atTurn });
  }
}

const TOOL_LOOKUP_PARAMETERS = {
  type: "object" as const,
  properties: {
    name: {
      type: "string",
      description:
        "The name of a deferred (cold) tool whose schema you want to load. Must be one of the cold tools listed in your system prompt.",
    },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

const TOOL_LOOKUP_DESCRIPTION = [
  "Load the full JSON schema for a deferred (cold) tool that is not currently in your active tool set.",
  "Cold tools are listed by name + one-line blurb in your system prompt's available_tools index.",
  "Calling tool_lookup({ name: '<tool_name>' }) returns that tool's full schema AND unlocks it for use in subsequent turns of this session.",
  "Once unlocked, the tool stays available until it has not been used (or re-looked-up) for `coldUnlockTtlTurns` turns (default 5), at which point it drops back to cold.",
  "If you call tool_lookup with an invalid or hot tool name, you'll get an error message describing what's available.",
].join(" ");

export function createToolLookupMetaTool(params: {
  /** All registered tools BEFORE hot/cold filtering — for schema retrieval. */
  allTools: AnyAgentTool[];
  /** The agent's hot tool name list. Used to reject lookups for hot tools (no point). */
  hotTools: Set<string>;
  /** The session this tool is bound to. Unlocks are scoped per session. */
  sessionKey: string;
  /** The turn number at which this tool factory was invoked. */
  currentTurn: number;
}): AnyAgentTool {
  const allByName = new Map(params.allTools.map((t) => [t.name, t]));
  return {
    name: "tool_lookup",
    label: "tool_lookup",
    displaySummary: "Load schema for a deferred cold tool",
    description: TOOL_LOOKUP_DESCRIPTION,
    parameters: TOOL_LOOKUP_PARAMETERS as unknown as AnyAgentTool["parameters"],
    execute: (async (
      _toolCallId: unknown,
      args: { name?: unknown } | undefined,
    ): Promise<{ output: string }> => {
      const requested =
        args && typeof args.name === "string" ? args.name.trim() : "";
      if (!requested) {
        return {
          output:
            "Error: tool_lookup requires a `name` string. Pass the name of a cold tool from your system prompt's available_tools index.",
        };
      }
      const target = allByName.get(requested);
      if (!target) {
        const cold = Array.from(allByName.keys()).filter(
          (n) => !params.hotTools.has(n) && n !== "tool_lookup",
        );
        return {
          output: `Error: tool '${requested}' is not a registered tool. Cold tools available for lookup: ${cold.join(", ") || "(none)"}.`,
        };
      }
      if (params.hotTools.has(requested)) {
        return {
          output: `Note: '${requested}' is already a HOT tool — its schema is in your active tool set every turn. No lookup needed.`,
        };
      }
      if (requested === "tool_lookup") {
        return {
          output:
            "Error: cannot look up tool_lookup itself. It is always in your active tool set.",
        };
      }
      recordUnlock(params.sessionKey, requested, params.currentTurn);
      const schemaPayload = {
        name: target.name,
        description:
          typeof target.description === "string" ? target.description : "",
        parameters: target.parameters,
      };
      return {
        output: [
          `Schema loaded for '${requested}'. It is now in your active tool set for the next ${
            5
          } turns (configurable via tools.coldUnlockTtlTurns). Call it like any other tool.`,
          "",
          "```json",
          JSON.stringify(schemaPayload, null, 2),
          "```",
        ].join("\n"),
      };
    }) as AnyAgentTool["execute"],
  } as AnyAgentTool;
}

/**
 * Build the cold-tool index text (added to the system prompt) so the agent
 * knows what cold tools exist and what each does at a glance, without paying
 * for full schemas.
 */
export function buildColdToolIndex(params: {
  allTools: AnyAgentTool[];
  hotTools: Set<string>;
}): string {
  const cold = params.allTools.filter(
    (t) => !params.hotTools.has(t.name) && t.name !== "tool_lookup",
  );
  if (cold.length === 0) {
    return "";
  }
  const lines: string[] = [];
  lines.push("");
  lines.push(
    "## Deferred Tools (load schema via tool_lookup before use)",
  );
  lines.push(
    "These tools are available but their full schemas are not loaded by default. To use one, call `tool_lookup({ name: \"<tool_name>\" })` first; that returns the schema and unlocks the tool for the next 5 turns.",
  );
  lines.push("");
  lines.push("<deferred_tools>");
  for (const tool of cold) {
    const summary =
      typeof tool.displaySummary === "string" && tool.displaySummary.trim()
        ? tool.displaySummary.trim()
        : typeof tool.description === "string"
          ? tool.description.split(/\n/)[0]?.slice(0, 120) ?? ""
          : "";
    lines.push(`  <tool name="${tool.name}">${summary}</tool>`);
  }
  lines.push("</deferred_tools>");
  return lines.join("\n");
}
