import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtom } from 'jotai';
import isEqual from 'lodash/isEqual';
import { useRecoilState } from 'recoil';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import { ephemeralAgentByConvoId, mcpValuesAtomFamily, mcpPinnedAtom } from '~/store';
import { MCPServerDefinition } from './useMCPServerManager';
import { useGetStartupConfig } from '~/data-provider';
import { setTimestamp } from '~/utils/timestamps';

/** Sentinel in `interface.defaultPinnedTools` that pins the MCP dropdown to the prompt bar. */
const MCP_PIN_KEYWORD = 'mcp';

export function useMCPSelect({
  conversationId,
  storageContextKey,
  servers,
}: {
  conversationId?: string | null;
  storageContextKey?: string;
  servers: MCPServerDefinition[];
}) {
  const key = conversationId ?? Constants.NEW_CONVO;
  const configuredServers = useMemo(() => {
    return new Set(servers?.map((s) => s.serverName));
  }, [servers]);

  /**
   * For new conversations, key the MCP atom by environment (spec or defaults)
   * so switching between spec ↔ non-spec gives each its own atom.
   * For existing conversations, key by conversation ID for per-conversation isolation.
   */
  const isNewConvo = key === Constants.NEW_CONVO;
  const mcpAtomKey = isNewConvo && storageContextKey ? storageContextKey : key;

  const { data: startupConfig } = useGetStartupConfig();
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
  const mcpSearchParam = useMemo(
    () => new URLSearchParams(window.location.search).get('mcp'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [window.location.search],
  );

  useEffect(() => {
    // Wait for backend servers to load
    if (configuredServers.size === 0) return;

    if (mcpSearchParam) {
      // Parse URL and filter valid servers
      const requestedServers = mcpSearchParam.split(',').map((s) => s.trim());
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
    }
  }, [configuredServers, setMCPValuesRaw, setEphemeralAgent, key, mcpSearchParam]);

  // Sync Jotai state with ephemeral agent state
  useEffect(() => {
    // If servers haven't loaded yet, do NOT attempt to filter/sync.
    if (configuredServers.size === 0) return;

    /**
     * `ephemeralAgentByConvoId` is keyed by `Constants.NEW_CONVO` for every not-yet-persisted
     * conversation, so it can carry a stale `mcp` selection over from a *previous* new chat in
     * the same tab. Defer to the URL-handling effect above while a `?mcp=` param is still
     * present, regardless of which effect's async dependencies (servers query vs. ephemeral
     * agent hydration) happen to resolve first — a one-shot flag tied to commit ordering isn't
     * reliable here since that ordering varies with cache/network timing between calls.
     */
    if (mcpSearchParam) return;

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
  }, [ephemeralAgent?.mcp, setMCPValuesRaw, configuredServers, mcpSearchParam]);

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
