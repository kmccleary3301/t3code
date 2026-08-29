import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceState } from "../../state/workspace";
import {
  collectNativeSessionTargets,
  filterNativeSessionItems,
  nativeSessionCommandTarget,
  type NativeSessionItem,
} from "./nativeSessionList";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The native session operation failed.";
}

export function NativeSessionsRouteScreen() {
  const navigation = useNavigation();
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const serverConfigs = useServerConfigs();
  const { environments } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const loadNativeSessions = useAtomQueryRunner(serverEnvironment.nativeSessions, {
    reportFailure: false,
  });
  const openNativeSession = useAtomCommand(serverEnvironment.openNativeSession, {
    reportFailure: false,
  });
  const renameNativeSession = useAtomCommand(serverEnvironment.renameNativeSession, {
    reportFailure: false,
  });
  const forkNativeSession = useAtomCommand(serverEnvironment.forkNativeSession, {
    reportFailure: false,
  });
  const stopNativeSession = useAtomCommand(serverEnvironment.stopNativeSession, {
    reportFailure: false,
  });
  const archiveNativeSession = useAtomCommand(serverEnvironment.archiveNativeSession, {
    reportFailure: false,
  });
  const [items, setItems] = useState<ReadonlyArray<NativeSessionItem>>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<NativeSessionItem | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const targets = useMemo(
    () => collectNativeSessionTargets(environments, serverConfigs, savedConnectionsById),
    [environments, savedConnectionsById, serverConfigs],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    const results = await Promise.all(
      targets.map(async (target) => ({
        target,
        result: await loadNativeSessions({
          environmentId: target.environmentId,
          input: { providerInstanceId: target.providerInstanceId },
        }),
      })),
    );
    const nextItems: NativeSessionItem[] = [];
    let firstError: unknown;
    for (const { target, result } of results) {
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result) && firstError === undefined) {
          firstError = squashAtomCommandFailure(result);
        }
        continue;
      }
      for (const session of result.value.sessions) nextItems.push({ ...target, session });
    }
    nextItems.sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
    setItems(nextItems);
    setLoading(false);
    if (firstError !== undefined)
      Alert.alert("Some sessions could not be loaded", errorMessage(firstError));
  }, [loadNativeSessions, targets]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredItems = useMemo(() => filterNativeSessionItems(items, query), [items, query]);

  const navigateToThread = useCallback(
    (environmentId: EnvironmentId, threadId: string) => {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        }),
      );
    },
    [navigation],
  );

  const runOpen = useCallback(
    async (item: NativeSessionItem) => {
      const key = `${item.environmentId}:${item.providerInstanceId}:${item.session.sessionId}`;
      setBusyKey(key);
      const result = await openNativeSession(nativeSessionCommandTarget(item));
      setBusyKey(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          Alert.alert("Could not open session", errorMessage(squashAtomCommandFailure(result)));
        }
        return;
      }
      navigateToThread(item.environmentId, result.value.threadId);
    },
    [navigateToThread, openNativeSession],
  );

  const runLifecycle = useCallback(
    async (item: NativeSessionItem, operation: "fork" | "stop" | "archive") => {
      const key = `${item.environmentId}:${item.providerInstanceId}:${item.session.sessionId}`;
      setBusyKey(key);
      const target = nativeSessionCommandTarget(item);
      if (operation === "fork") {
        const result = await forkNativeSession(target);
        setBusyKey(null);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            Alert.alert("Could not fork session", errorMessage(squashAtomCommandFailure(result)));
          }
          return;
        }
        navigateToThread(item.environmentId, result.value.threadId);
        return;
      }
      const result =
        operation === "stop" ? await stopNativeSession(target) : await archiveNativeSession(target);
      setBusyKey(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          Alert.alert(
            `Could not ${operation} session`,
            errorMessage(squashAtomCommandFailure(result)),
          );
        }
        return;
      }
      await refresh();
    },
    [archiveNativeSession, forkNativeSession, navigateToThread, refresh, stopNativeSession],
  );

  const submitRename = useCallback(async () => {
    const item = renameTarget;
    const name = renameValue.trim();
    if (!item || name.length === 0) return;
    setRenameTarget(null);
    const key = `${item.environmentId}:${item.providerInstanceId}:${item.session.sessionId}`;
    setBusyKey(key);
    const target = nativeSessionCommandTarget(item);
    const result = await renameNativeSession({
      ...target,
      input: { ...target.input, name },
    });
    setBusyKey(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        Alert.alert("Could not rename session", errorMessage(squashAtomCommandFailure(result)));
      }
      return;
    }
    await refresh();
  }, [refresh, renameNativeSession, renameTarget, renameValue]);

  return (
    <View className="flex-1 bg-screen">
      <View className="border-b border-border px-4 py-3">
        <View className="min-h-12 flex-row items-center gap-2 rounded-2xl border border-input-border bg-input px-3.5">
          <SymbolView name="magnifyingglass" size={17} tintColor={mutedColor} type="monochrome" />
          <TextInput
            accessibilityLabel="Search native sessions"
            autoCapitalize="none"
            className="flex-1 py-2.5 text-base font-sans text-foreground"
            onChangeText={setQuery}
            placeholder="Search sessions"
            placeholderTextColorClassName="accent-placeholder"
            value={query}
          />
        </View>
      </View>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 px-4 py-4"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} />}
      >
        {loading && items.length === 0 ? (
          <View className="items-center py-12">
            <ActivityIndicator />
          </View>
        ) : filteredItems.length === 0 ? (
          <View className="items-center gap-2 py-12">
            <SymbolView
              name="clock.arrow.circlepath"
              size={28}
              tintColor={mutedColor}
              type="monochrome"
            />
            <Text className="text-center text-base font-t3-medium text-foreground-muted">
              {targets.length === 0
                ? "No connected Pi or OMP providers"
                : "No native sessions found"}
            </Text>
          </View>
        ) : (
          filteredItems.map((item) => {
            const key = `${item.environmentId}:${item.providerInstanceId}:${item.session.sessionId}`;
            const busy = busyKey === key;
            return (
              <View key={key} className="gap-3 rounded-2xl border border-border bg-card p-4">
                <Pressable disabled={busy} onPress={() => void runOpen(item)}>
                  <View className="flex-row items-start gap-3">
                    <SymbolView
                      name="clock.arrow.circlepath"
                      size={20}
                      tintColor={iconColor}
                      type="monochrome"
                    />
                    <View className="flex-1 gap-1">
                      <Text className="text-base font-t3-bold text-foreground">
                        {item.session.title}
                      </Text>
                      <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                        {item.session.cwd}
                      </Text>
                      <Text className="text-xs font-t3-medium text-foreground-muted">
                        {item.environmentLabel} · {item.providerLabel} ·{" "}
                        {item.session.runtime.toUpperCase()}
                        {item.session.model ? ` · ${item.session.model}` : ""}
                      </Text>
                    </View>
                    {busy ? <ActivityIndicator size="small" /> : null}
                  </View>
                </Pressable>
                <View className="flex-row flex-wrap gap-2">
                  <LifecycleButton
                    label="Open"
                    onPress={() => void runOpen(item)}
                    disabled={busy}
                  />
                  <LifecycleButton
                    label="Rename"
                    onPress={() => {
                      setRenameValue(item.session.title);
                      setRenameTarget(item);
                    }}
                    disabled={busy}
                  />
                  <LifecycleButton
                    label="Fork"
                    onPress={() => void runLifecycle(item, "fork")}
                    disabled={busy}
                  />
                  <LifecycleButton
                    label="Stop"
                    onPress={() => void runLifecycle(item, "stop")}
                    disabled={busy}
                  />
                  <LifecycleButton
                    label="Archive thread"
                    onPress={() => void runLifecycle(item, "archive")}
                    disabled={busy}
                  />
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
      <Modal
        animationType="fade"
        onRequestClose={() => setRenameTarget(null)}
        transparent
        visible={renameTarget !== null}
      >
        <View className="flex-1 items-center justify-center bg-black/40 px-6">
          <View className="w-full max-w-[480px] gap-4 rounded-2xl bg-card p-5">
            <Text className="text-lg font-t3-bold text-foreground">Rename native session</Text>
            <TextInput
              autoFocus
              className="rounded-xl border border-input-border bg-input px-3 py-3 text-base text-foreground"
              onChangeText={setRenameValue}
              onSubmitEditing={() => void submitRename()}
              selectTextOnFocus
              value={renameValue}
            />
            <View className="flex-row justify-end gap-2">
              <LifecycleButton label="Cancel" onPress={() => setRenameTarget(null)} />
              <LifecycleButton
                label="Rename"
                onPress={() => void submitRename()}
                disabled={renameValue.trim().length === 0}
              />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function LifecycleButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="rounded-full bg-subtle px-3 py-2 disabled:opacity-40"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text className="text-sm font-t3-bold text-foreground">{props.label}</Text>
    </Pressable>
  );
}
