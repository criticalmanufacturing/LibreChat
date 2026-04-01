import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtom } from 'jotai';
import isEqual from 'lodash/isEqual';
import { useRecoilState } from 'recoil';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import { ephemeralAgentByConvoId, mcpValuesAtomFamily, mcpPinnedAtom } from '~/store';
import { setTimestamp } from '~/utils/timestamps';
import { MCPServerDefinition } from './useMCPServerManager';

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

  const [isPinned, setIsPinned] = useAtom(mcpPinnedAtom);
  const [mcpValues, setMCPValuesRaw] = useAtom(mcpValuesAtomFamily(mcpAtomKey));
  const [ephemeralAgent, setEphemeralAgent] = useRecoilState(ephemeralAgentByConvoId(key));

  // Track if we are currently applying a URL update to prevent sync-back overwrites
  const isUpdatingFromURL = useRef(false);

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

      if (validServers.length > 0) {
        isUpdatingFromURL.current = true;
        
        // 1. Update UI Atom
        setMCPValuesRaw(validServers);
        
        // 2. Update Ephemeral Agent (Recoil) immediately to stay in sync
        setEphemeralAgent((prev) => ({ ...(prev ?? {}), mcp: validServers }));

        // 3. Update LocalStorage for persistence
        if (storageContextKey) {
          const envKey = `${LocalStorageKeys.LAST_MCP_}${storageContextKey}`;
          localStorage.setItem(envKey, JSON.stringify(validServers));
          setTimestamp(envKey);
        }
      }

      // Clean the URL
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('mcp');
      window.history.replaceState({}, '', newUrl.toString());

      // Release the lock after a short delay to allow React state to settle
      setTimeout(() => { isUpdatingFromURL.current = false; }, 100);
    }
  }, [configuredServers, setMCPValuesRaw, setEphemeralAgent, storageContextKey]);

  // Sync ephemeral agent MCP → Jotai atom (strip unconfigured servers)
  useEffect(() => {
    // If servers haven't loaded yet, do NOT attempt to filter/sync.
    if (configuredServers.size === 0 || isUpdatingFromURL.current) return;

    const mcps = ephemeralAgent?.mcp ?? [];
    
    if (mcps.length === 1 && mcps[0] === Constants.mcp_clear) {
      setMCPValuesRaw([]);
    } else if (Array.isArray(mcps)) {
      const activeMcps = mcps.filter((mcp) => configuredServers.has(mcp));
      
      setMCPValuesRaw((prev) => {
        if (isEqual(prev, activeMcps)) return prev;
        return activeMcps;
      });
    }
  }, [ephemeralAgent?.mcp, configuredServers, setMCPValuesRaw]);

  useEffect(() => {
    if (isUpdatingFromURL.current) return;

    setEphemeralAgent((prev) => {
      if (!isEqual(prev?.mcp, mcpValues)) {
        return { ...(prev ?? {}), mcp: mcpValues };
      }
      return prev;
    });
  }, [mcpValues, setEphemeralAgent]);

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
      if (!Array.isArray(value)) return;
      setMCPValuesRaw(value);
      
      // Also update Recoil and Storage for manual changes
      setEphemeralAgent((prev) => ({ ...(prev ?? {}), mcp: value }));
      
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
