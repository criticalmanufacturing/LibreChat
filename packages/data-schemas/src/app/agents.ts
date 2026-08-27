import { EModelEndpoint, agentsEndpointSchema, extractEnvVariable } from 'librechat-data-provider';
import type { TCustomConfig, TAgentsEndpoint } from 'librechat-data-provider';

/**
 * Sets up the Agents configuration from the config (`librechat.yaml`) file.
 * If no agents config is defined, uses the provided defaults or parses empty object.
 *
 * @param config - The loaded custom configuration.
 * @param [defaultConfig] - Default configuration from getConfigDefaults.
 * @returns The Agents endpoint configuration.
 */
export function agentsConfigSetup(
  config: Partial<TCustomConfig>,
  defaultConfig?: Partial<TAgentsEndpoint>,
): Partial<TAgentsEndpoint> {
  const agentsConfig = config?.endpoints?.[EModelEndpoint.agents];

  if (!agentsConfig) {
    return defaultConfig || agentsEndpointSchema.parse({});
  }

  const oidc = agentsConfig.remoteApi?.auth?.oidc;
  const resolvedConfig = oidc
    ? {
        ...agentsConfig,
        remoteApi: {
          ...agentsConfig.remoteApi,
          auth: {
            ...agentsConfig.remoteApi?.auth,
            oidc: {
              ...oidc,
              issuer: oidc.issuer ? extractEnvVariable(oidc.issuer) : oidc.issuer,
              audience: oidc.audience ? extractEnvVariable(oidc.audience) : oidc.audience,
            },
          },
        },
      }
    : agentsConfig;
  const parsedConfig = agentsEndpointSchema.parse(resolvedConfig);
  return parsedConfig;
}
