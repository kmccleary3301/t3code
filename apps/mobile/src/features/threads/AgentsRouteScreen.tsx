import {
  deriveAgentPanelModel,
  foldNativeUiActivities,
  foldSubagentActivities,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { EnvironmentId, ThreadId, type OrchestrationSessionStatus } from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import { useCallback, useMemo } from "react";
import { Platform, ScrollView, View } from "react-native";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { useThreadDetail } from "../../state/use-thread-detail";
import { AgentsPanel } from "./AgentsPanel";

type AgentsRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function firstRouteParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}
function sessionSupportsLiveAgents(status: OrchestrationSessionStatus | null): boolean {
  return status === "starting" || status === "running" || status === "ready";
}

export function AgentsRouteScreen(props: AgentsRouteScreenProps) {
  const navigation = useNavigation();
  const { connectionState } = useRemoteConnectionStatus();
  const environmentIdRaw = firstRouteParam(props.route.params.environmentId);
  const threadIdRaw = firstRouteParam(props.route.params.threadId);
  const environmentId = environmentIdRaw === null ? null : EnvironmentId.make(environmentIdRaw);
  const threadId = threadIdRaw === null ? null : ThreadId.make(threadIdRaw);
  const threadState = useThreadDetail({ environmentId, threadId });
  const thread = Option.getOrNull(threadState.data);
  const runtime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    runtime?.connectionState ?? (environmentId ? "available" : connectionState);
  const connectionError = runtime?.connectionError ?? null;
  const handleBack = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (environmentIdRaw !== null && threadIdRaw !== null) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: environmentIdRaw,
          threadId: threadIdRaw,
        }),
      );
      return;
    }
    navigation.dispatch(StackActions.replace("Home"));
  }, [environmentIdRaw, navigation, threadIdRaw]);

  const model = useMemo(() => {
    if (thread === null) return deriveAgentPanelModel({ agents: [] });
    const sessionLive = sessionSupportsLiveAgents(thread.session?.status ?? null);
    return deriveAgentPanelModel({
      agents: foldSubagentActivities(thread.activities, { sessionLive }),
    });
  }, [thread]);
  const nativeUiState = useMemo(
    () => foldNativeUiActivities(thread?.activities ?? []),
    [thread?.activities],
  );
  const connectionNotice =
    routeConnectionState === "connecting" || routeConnectionState === "reconnecting"
      ? "Reconnecting — showing cached agent data."
      : routeConnectionState === "offline" || routeConnectionState === "error"
        ? (connectionError ?? "Environment connection is unavailable.")
        : null;
  const agentsHeader = (
    <>
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: "Agents",
          headerTitle: "Agents",
          headerBackVisible: navigation.canGoBack(),
          unstable_headerLeftItems: navigation.canGoBack()
            ? undefined
            : () => [
                withNativeGlassHeaderItem({
                  accessibilityLabel: "Back to thread",
                  icon: { name: "chevron.left", type: "sfSymbol" as const },
                  identifier: "agents-left-back",
                  onPress: handleBack,
                  type: "button" as const,
                }),
              ],
          unstable_headerSubtitle: thread?.title ?? undefined,
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Agents" subtitle={thread?.title} onBack={handleBack} />
      ) : null}
    </>
  );

  if (environmentId === null || threadId === null) {
    return (
      <View className="flex-1 bg-screen">
        {agentsHeader}
        <LoadingScreen message="Opening Agents…" messagePlacement="above-spinner" />
      </View>
    );
  }
  if (thread === null) {
    if (Option.isSome(threadState.error)) {
      return (
        <View className="flex-1 bg-screen">
          {agentsHeader}
          <ScrollView
            contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24 }}
          >
            <EmptyState
              title="Agents unavailable"
              detail={Option.getOrElse(
                threadState.error,
                () => connectionError ?? "The thread could not be loaded.",
              )}
              actionLabel="Back to thread"
              onAction={handleBack}
            />
          </ScrollView>
        </View>
      );
    }
    return (
      <View className="flex-1 bg-screen">
        {agentsHeader}
        <LoadingScreen message="Loading Agents…" messagePlacement="above-spinner" />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      {agentsHeader}
      <AgentsPanel
        model={model}
        nativeUiState={nativeUiState}
        environmentId={environmentId}
        threadId={threadId}
      />
      {connectionNotice !== null ? (
        <View className="border-t border-border bg-card px-4 py-2">
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
            {connectionNotice}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
