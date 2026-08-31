import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderNativeSessionSummary,
  ServerProvider,
} from "@t3tools/contracts";

import type { WorkspaceEnvironment } from "../../state/workspaceModel";

export type NativeSessionTarget = {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerLabel: string;
};

export type NativeSessionItem = NativeSessionTarget & {
  readonly session: ProviderNativeSessionSummary;
};

export type NativeSessionDiscoveryEnvironment = Pick<
  WorkspaceEnvironment,
  "environmentId" | "environmentLabel" | "connectionState"
>;

export type NativeSessionDiscoveryConfig = {
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "enabled" | "installed" | "displayName">
  >;
};

export function collectNativeSessionTargets(
  environments: ReadonlyArray<NativeSessionDiscoveryEnvironment>,
  serverConfigs: ReadonlyMap<EnvironmentId, NativeSessionDiscoveryConfig>,
): ReadonlyArray<NativeSessionTarget> {
  const targets: NativeSessionTarget[] = [];
  for (const environment of environments) {
    if (environment.connectionState !== "connected") continue;
    const config = serverConfigs.get(environment.environmentId);
    if (!config) continue;
    for (const provider of config.providers) {
      if (
        (provider.driver !== "pi" && provider.driver !== "omp") ||
        !provider.enabled ||
        !provider.installed
      )
        continue;
      targets.push({
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel,
        providerInstanceId: provider.instanceId,
        providerLabel: provider.displayName ?? provider.driver.toUpperCase(),
      });
    }
  }
  return targets;
}
export function nativeSessionItemKey(item: NativeSessionItem): string {
  return `${item.environmentId}:${item.providerInstanceId}:${item.session.sessionId}`;
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
