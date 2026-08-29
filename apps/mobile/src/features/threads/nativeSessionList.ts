import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderNativeSessionSummary,
} from "@t3tools/contracts";

export type NativeSessionTarget = {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerLabel: string;
};

export type NativeSessionItem = NativeSessionTarget & {
  readonly session: ProviderNativeSessionSummary;
};

export type NativeSessionDiscoveryEnvironment = {
  readonly environmentId: EnvironmentId;
  readonly connectionState: string;
};

export type NativeSessionDiscoveryConfig = {
  readonly providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driver: string;
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly displayName?: string;
  }>;
};

export function collectNativeSessionTargets(
  environments: ReadonlyArray<NativeSessionDiscoveryEnvironment>,
  serverConfigs: ReadonlyMap<EnvironmentId, NativeSessionDiscoveryConfig>,
  savedConnectionsById: Readonly<Record<string, { readonly environmentLabel: string } | undefined>>,
): ReadonlyArray<NativeSessionTarget> {
  const targets: NativeSessionTarget[] = [];
  for (const environment of environments) {
    if (environment.connectionState !== "connected") continue;
    const config = serverConfigs.get(environment.environmentId);
    if (!config) continue;
    const saved = savedConnectionsById[environment.environmentId];
    for (const provider of config.providers) {
      if (
        (provider.driver !== "pi" && provider.driver !== "omp") ||
        !provider.enabled ||
        !provider.installed
      )
        continue;
      targets.push({
        environmentId: environment.environmentId,
        environmentLabel: saved?.environmentLabel ?? environment.environmentId,
        providerInstanceId: provider.instanceId,
        providerLabel: provider.displayName ?? provider.driver.toUpperCase(),
      });
    }
  }
  return targets;
}

export function nativeSessionCommandTarget(item: NativeSessionItem) {
  return {
    environmentId: item.environmentId,
    input: {
      providerInstanceId: item.providerInstanceId,
      sessionId: item.session.sessionId,
    },
  } as const;
}

function sessionSearchText(item: NativeSessionItem): string {
  return [
    item.session.title,
    item.session.cwd,
    item.session.model,
    item.session.status,
    item.session.runtime,
    item.environmentLabel,
    item.providerLabel,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ")
    .toLocaleLowerCase();
}

export function filterNativeSessionItems(
  items: ReadonlyArray<NativeSessionItem>,
  query: string,
): ReadonlyArray<NativeSessionItem> {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized.length === 0
    ? items
    : items.filter((item) => sessionSearchText(item).includes(normalized));
}
