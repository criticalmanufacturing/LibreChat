import { useCallback, useEffect, useMemo } from 'react';
import { useAtom } from 'jotai';
import isEqual from 'lodash/isEqual';
import { useRecoilState } from 'recoil';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import { ephemeralAgentByConvoId, mcpValuesAtomFamily, mcpPinnedAtom } from '~/store';
import { setTimestamp } from '~/utils/timestamps';
import { MCPServerDefinition } from './useMCPServerManager';

export function useMCPSelect({
  conversationId,
  servers,
}: {
  conversationId?: string | null;
  servers: MCPServerDefinition[];
}) {
  const key = conversationId ?? Constants.NEW_CONVO;
  const configuredServers = useMemo(() => {
    return new Set(servers?.map((s) => s.serverName));
  }, [servers]);

  const [isPinned, setIsPinned] = useAtom(mcpPinnedAtom);
  const [mcpValues, setMCPValuesRaw] = useAtom(mcpValuesAtomFamily(key));
  const [ephemeralAgent, setEphemeralAgent] = useRecoilState(ephemeralAgentByConvoId(key));

  /** * Handle URL Parameter & Clean Up
   * 1. Reads ?mcp=mcp_server_name
   * 2. Overwrites current selection to match URL.
   * 3. Removes 'mcp' from the address bar so manual changes stick later.
   */
  useEffect(() => {
    // Wait for backend servers to load
    if (configuredServers.size === 0) return;

    const params = new URLSearchParams(window.location.search);
    const mcpParam = params.get('mcp');

    if (mcpParam) {
      // Parse URL and filter valid servers
      const requestedServers = mcpParam.split(',').map((s) => s.trim());
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

      // Clean the URL after applying
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('mcp');
      window.history.replaceState({}, '', newUrl.toString());
    }
  }, [configuredServers, setMCPValuesRaw, key]);

  // Sync Jotai state with ephemeral agent state
  useEffect(() => {
    // If servers haven't loaded yet, do NOT attempt to filter/sync.
    if (configuredServers.size === 0) return;

    const mcps = ephemeralAgent?.mcp ?? [];
    if (mcps.length === 1 && mcps[0] === Constants.mcp_clear) {
      setMCPValuesRaw([]);
    } else if (mcps.length > 0) {
      // Strip out servers that are not available in the startup config
      const activeMcps = mcps.filter((mcp) => configuredServers.has(mcp));

      // Prevent unnecessary updates that might cause loops
      setMCPValuesRaw((prev) => {
        if (isEqual(prev, activeMcps)) return prev;
        return activeMcps;
      });
    }
  }, [ephemeralAgent?.mcp, setMCPValuesRaw, configuredServers]);

  useEffect(() => {
    setEphemeralAgent((prev) => {
      if (!isEqual(prev?.mcp, mcpValues)) {
        return { ...(prev ?? {}), mcp: mcpValues };
      }
      return prev;
    });
  }, [mcpValues, setEphemeralAgent]);

  useEffect(() => {
    const mcpStorageKey = `${LocalStorageKeys.LAST_MCP_}${key}`;
    if (mcpValues.length > 0) {
      setTimestamp(mcpStorageKey);
    }
  }, [mcpValues, key]);

  /** Stable memoized setter */
  const setMCPValues = useCallback(
    (value: string[]) => {
      if (!Array.isArray(value)) {
        return;
      }
      setMCPValuesRaw(value);
    },
    [setMCPValuesRaw],
  );

  return {
    isPinned,
    mcpValues,
    setIsPinned,
    setMCPValues,
  };
}
