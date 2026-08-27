import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtom } from 'jotai';
import isEqual from 'lodash/isEqual';
import { useRecoilState } from 'recoil';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import type { MCPServerDefinition } from './useMCPServerManager';
import { ephemeralAgentByConvoId, mcpValuesAtomFamily, mcpPinnedAtom } from '~/store';
import { useGetStartupConfig } from '~/data-provider';
import { setTimestamp } from '~/utils/timestamps';
import { getModelSpec } from '~/utils';

/** Sentinel in `interface.defaultPinnedTools` that pins the MCP dropdown to the prompt bar. */
const MCP_PIN_KEYWORD = 'mcp';

export function useMCPSelect({
  conversationId,
  storageContextKey,
  servers,
  allServers,
  specName,
  ownsChatSelection = false,
}: {
  conversationId?: string | null;
  storageContextKey?: string;
  /** Chat-selectable servers, i.e. the subset the dropdown offers. */
  servers: MCPServerDefinition[];
  /** Every server the catalog returned, selectable or not. Defaults to `servers`. */
  allServers?: MCPServerDefinition[];
  /** Active model spec, whose pinned servers are exempt from pruning. */
  specName?: string | null;
  /**
   * Whether this instance drives the chat picker and may therefore rewrite the
   * shared selection. Off by default: every instance keyed to a conversation
   * shares one atom and one ephemeral agent, so a caller mounted for the catalog
   * alone — with no spec context to exempt from — would otherwise prune away a
   * selection the picker's own instance is deliberately keeping.
   */
  ownsChatSelection?: boolean;
}) {
  const key = conversationId ?? Constants.NEW_CONVO;
  const configuredServers = useMemo(() => {
    return new Set(servers?.map((s) => s.serverName));
  }, [servers]);
  /**
   * Whether the catalog has told us enough to forget a stale selection.
   *
   * Gating on the UNFILTERED list is what makes a `chatMenu: false` server
   * clearable: when every configured server is hidden, `servers` is empty and a
   * guard on it can never fire, so a selection persisted while the server was
   * visible stays active forever. The unfiltered list is non-empty in that case.
   *
   * It stays a guard rather than a load flag because `mcpValues` writes through
   * to localStorage: an empty catalog — still loading, or a degraded read — must
   * never be read as "the admin removed everything" and wipe the selection.
   */
  const canPruneSelections = ownsChatSelection && (allServers ?? servers).length > 0;
  const { data: startupConfig } = useGetStartupConfig();
  /**
   * Selections that survive pruning: what the dropdown offers, plus whatever the
   * active model spec pins. `chatMenu` hides a server from the picker; it does
   * not override an admin's spec, so a spec-assigned server stays selected even
   * when the picker would never have offered it.
   */
  const retainedServers = useMemo(() => {
    const specServers = getModelSpec({ specName, startupConfig })?.mcpServers;
    if (!specServers?.length) {
      return configuredServers;
    }
    const retained = new Set(configuredServers);
    for (const serverName of specServers) {
      retained.add(serverName);
    }
    return retained;
  }, [configuredServers, specName, startupConfig]);

  /**
   * For new conversations, key the MCP atom by environment (spec or defaults)
   * so switching between spec ↔ non-spec gives each its own atom.
   * For existing conversations, key by conversation ID for per-conversation isolation.
   */
  const isNewConvo = key === Constants.NEW_CONVO;
  const mcpAtomKey = isNewConvo && storageContextKey ? storageContextKey : key;

  const [isPinned, setIsPinned] = useAtom(mcpPinnedAtom);
  const [mcpValues, setMCPValuesRaw] = useAtom(mcpValuesAtomFamily(mcpAtomKey));
  const [ephemeralAgent, setEphemeralAgent] = useRecoilState(ephemeralAgentByConvoId(key));
  const hasAppliedDefaultPin = useRef(false);

  /**
   * Seed the MCP dropdown's pinned state from the admin-configured `defaultPinnedTools`:
   * pin when the array includes the `'mcp'` keyword or any configured server name.
   * Only applies on first load when the user has no stored preference; when the option
   * is absent entirely, the legacy default (pinned) is kept.
   */
  useEffect(() => {
    if (hasAppliedDefaultPin.current || !startupConfig) {
      return;
    }
    const defaultPinnedTools = startupConfig.interface?.defaultPinnedTools;
    if (!Array.isArray(defaultPinnedTools)) {
      hasAppliedDefaultPin.current = true;
      return;
    }
    if (localStorage.getItem(LocalStorageKeys.PIN_MCP_) != null) {
      hasAppliedDefaultPin.current = true;
      return;
    }
    const pinnedByKeyword = defaultPinnedTools.includes(MCP_PIN_KEYWORD);
    /** Wait for servers before deciding so a configured server name isn't missed. */
    if (!pinnedByKeyword && servers.length === 0) {
      return;
    }
    hasAppliedDefaultPin.current = true;
    const shouldPin =
      pinnedByKeyword || servers.some((server) => defaultPinnedTools.includes(server.serverName));
    if (shouldPin !== isPinned) {
      setIsPinned(shouldPin);
    }
  }, [startupConfig, servers, isPinned, setIsPinned]);

  /** * Handle URL Parameter & Clean Up
   * 1. Reads ?mcp=mcp_server_name
   * 2. Overwrites current selection to match URL.
   * 3. Removes 'mcp' from the address bar so manual changes stick later.
   */
  const pendingMCPParamRef = useRef<string | null>(null);
  const mcpSearchParam = new URLSearchParams(window.location.search).get('mcp');
  /** URL settings cleanup can run before MCP server discovery finishes. */
  if (mcpSearchParam !== null) {
    pendingMCPParamRef.current = mcpSearchParam;
  }
  const pendingMCPParam = pendingMCPParamRef.current;

  useEffect(() => {
    // Wait for backend servers to load
    if (configuredServers.size === 0) return;

    if (pendingMCPParam !== null) {
      // Parse URL and filter valid servers
      const requestedServers = pendingMCPParam.split(',').map((s) => s.trim());
      const validServers = requestedServers.filter((name) => configuredServers.has(name));

      // Ignore 'current' state, replace with URL values
      setMCPValuesRaw((current) => {
        // If state is already identical, don't trigger a re-render
        const isLengthSame = current.length === validServers.length;
        const isContentSame = validServers.every((v) => current.includes(v));

        if (isLengthSame && isContentSame) {
          return current;
        }

        return validServers;
      });

      /**
       * Write `ephemeralAgent.mcp` here too so both state layers update together.
       * Both `mcpValuesAtomFamily('new')` (persisted to localStorage) and
       * `ephemeralAgentByConvoId(NEW_CONVO)` (in-memory Recoil) outlive a single "open" —
       * neither resets on an in-app close/reopen, only on a hard reload — so without this,
       * a stale ephemeralAgent value from a *previous* open can keep re-asserting itself
       * for a render or two after the URL value should have already won.
       */
      setEphemeralAgent((prev) => {
        if (!isEqual(prev?.mcp, validServers)) {
          return { ...(prev ?? {}), mcp: validServers };
        }
        return prev;
      });

      // Clean the URL after applying
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('mcp');
      window.history.replaceState({}, '', newUrl.toString());
      pendingMCPParamRef.current = null;
    }
  }, [configuredServers, setMCPValuesRaw, setEphemeralAgent, key, pendingMCPParam]);

  // Sync Jotai state with ephemeral agent state
  useEffect(() => {
    // If servers haven't loaded yet, do NOT attempt to filter/sync.
    if (configuredServers.size === 0) return;

    /**
     * `ephemeralAgentByConvoId` is keyed by `Constants.NEW_CONVO` for every not-yet-persisted
     * conversation, so it can carry a stale `mcp` selection over from a *previous* new chat in
     * the same tab. Defer to the URL-handling effect above while a `?mcp=` override is pending,
     * regardless of which effect's async dependencies (servers query vs. URL cleanup vs.
     * ephemeral agent hydration) happen to resolve first.
     */
    if (pendingMCPParam !== null) return;

    const mcps = ephemeralAgent?.mcp;
    if (!Array.isArray(mcps)) {
      return;
    }
    if (mcps.length === 0 || (mcps.length === 1 && mcps[0] === Constants.mcp_clear)) {
      setMCPValuesRaw([]);
    } else {
      // Strip out servers that are not available in the startup config
      const activeMcps = mcps.filter((mcp) => configuredServers.has(mcp));

      // Prevent unnecessary updates that might cause loops
      setMCPValuesRaw((prev) => {
        if (isEqual(prev, activeMcps)) return prev;
        return activeMcps;
      });
    }
  }, [ephemeralAgent?.mcp, setMCPValuesRaw, configuredServers, pendingMCPParam]);

  // Write timestamp when MCP values change
  useEffect(() => {
    const mcpStorageKey = `${LocalStorageKeys.LAST_MCP_}${mcpAtomKey}`;
    if (mcpValues.length > 0) {
      setTimestamp(mcpStorageKey);
    }
  }, [mcpValues, mcpAtomKey]);

  /** Stable memoized setter with dual-write to environment key */
  const setMCPValues = useCallback(
    (value: string[]) => {
      if (!Array.isArray(value)) {
        return;
      }
      setMCPValuesRaw(value);
      setEphemeralAgent((prev) => {
        if (!isEqual(prev?.mcp, value)) {
          return { ...(prev ?? {}), mcp: value };
        }
        return prev;
      });
      // Dual-write to environment key for new conversation defaults
      if (storageContextKey) {
        const envKey = `${LocalStorageKeys.LAST_MCP_}${storageContextKey}`;
        localStorage.setItem(envKey, JSON.stringify(value));
        setTimestamp(envKey);
      }
    },
    [setMCPValuesRaw, setEphemeralAgent, storageContextKey],
  );

  return {
    isPinned,
    mcpValues,
    setIsPinned,
    setMCPValues,
  };
}
