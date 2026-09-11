import * as Haptics from "expo-haptics";
import {
  type ActivityDetailBlock,
  parseActivityDetail,
  type ParsedActivityDetail,
} from "@t3tools/client-runtime/activity-details";
import { EventId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { PresentationSource } from "../../components/NativePresentation";
import { MaskedView } from "@expo/ui/community/masked-view";
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useId, useState, type ComponentProps } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  type ColorValue,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import type { ToolGroupSummaryKind } from "@t3tools/client-runtime/work-log/presentation";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

const SHIMMER_WIDTH = 72;
const SHIMMER_SWEEP_MS = 1_350;
const SHIMMER_PAUSE_MS = 1_450;
const SHIMMER_ICON_AND_GAP_WIDTH = 30;
export const THREAD_DISCLOSURE_TRANSITION_MS = 180;
const WORK_LOG_LAYOUT_TRANSITION = LinearTransition.duration(THREAD_DISCLOSURE_TRANSITION_MS);
const WORK_LOG_DETAIL_ENTER_TRANSITION = FadeIn.duration(140);
const WORK_LOG_DETAIL_EXIT_TRANSITION = FadeOut.duration(120);

function ShimmerWorkContent(props: {
  readonly highlighted: boolean;
  readonly icon: AppSymbolName;
  readonly iconSubtleColor: ColorValue;
  readonly label: string;
  readonly onTextLayout?: ComponentProps<typeof Text>["onTextLayout"];
  readonly showIcon: boolean;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      <View className="h-6 w-6 shrink-0 items-center justify-center">
        {props.showIcon ? (
          <SymbolView
            name={props.icon}
            size={14}
            weight="medium"
            {...(props.highlighted
              ? { tintColorClassName: "accent-foreground" as const }
              : { tintColor: props.iconSubtleColor })}
            type="monochrome"
          />
        ) : null}
      </View>
      <Text
        className={cn(
          "min-w-0 shrink text-sm",
          props.highlighted ? "text-foreground" : "text-foreground-muted",
        )}
        numberOfLines={1}
        onTextLayout={props.onTextLayout}
      >
        {props.label}
      </Text>
    </View>
  );
}

export function ShimmeringWorkContent(props: {
  readonly icon: AppSymbolName;
  readonly iconSubtleColor: ColorValue;
  readonly label: string;
  readonly showIcon: boolean;
}) {
  const [availableWidth, setAvailableWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === "active");
  const [reducedMotion, setReducedMotion] = useState(true);
  const screenIsFocused = useIsFocused();
  const progress = useSharedValue(0);
  const gradientId = `work-shimmer-${useId().replaceAll(":", "")}`;
  const contentWidth = Math.min(availableWidth, SHIMMER_ICON_AND_GAP_WIDTH + Math.ceil(textWidth));

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setAppIsActive(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (contentWidth <= 0 || reducedMotion || !appIsActive || !screenIsFocused) return;

    progress.value = withRepeat(
      withSequence(
        withTiming(1, {
          duration: SHIMMER_SWEEP_MS,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.Never,
        }),
        withDelay(
          SHIMMER_PAUSE_MS,
          withTiming(0, { duration: 0, reduceMotion: ReduceMotion.Never }),
        ),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    return () => cancelAnimation(progress);
  }, [appIsActive, contentWidth, progress, reducedMotion, screenIsFocused]);

  const sweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -SHIMMER_WIDTH + progress.value * (contentWidth + SHIMMER_WIDTH) }],
  }));
  const counterSweepStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: SHIMMER_WIDTH - progress.value * (contentWidth + SHIMMER_WIDTH) }],
  }));

  return (
    <View
      className="min-w-0 flex-1 overflow-hidden"
      onLayout={(event) => setAvailableWidth(event.nativeEvent.layout.width)}
    >
      <ShimmerWorkContent
        highlighted={false}
        icon={props.icon}
        iconSubtleColor={props.iconSubtleColor}
        label={props.label}
        showIcon={props.showIcon}
        onTextLayout={(event) => setTextWidth(event.nativeEvent.lines[0]?.width ?? 0)}
      />
      {!reducedMotion && appIsActive && screenIsFocused && contentWidth > 0 ? (
        <Animated.View
          className="absolute inset-y-0 left-0 overflow-hidden"
          pointerEvents="none"
          accessible={false}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[{ width: SHIMMER_WIDTH }, sweepStyle]}
        >
          <MaskedView
            style={StyleSheet.absoluteFill}
            maskElement={
              <Svg width="100%" height="100%">
                <Defs>
                  <LinearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="0%">
                    <Stop offset="0" stopColor="white" stopOpacity={0} />
                    <Stop offset="0.15" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="0.35" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.5" stopColor="white" stopOpacity={1} />
                    <Stop offset="0.65" stopColor="white" stopOpacity={0.55} />
                    <Stop offset="0.85" stopColor="white" stopOpacity={0.12} />
                    <Stop offset="1" stopColor="white" stopOpacity={0} />
                  </LinearGradient>
                </Defs>
                <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
              </Svg>
            }
          >
            <Animated.View style={[{ width: availableWidth }, counterSweepStyle]}>
              <ShimmerWorkContent
                highlighted
                icon={props.icon}
                iconSubtleColor={props.iconSubtleColor}
                label={props.label}
                showIcon={props.showIcon}
              />
            </Animated.View>
          </MaskedView>
        </Animated.View>
      ) : null}
    </View>
  );
}

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}
type ToolActivityDetailState =
  | { readonly status: "loading" }
  | { readonly status: "failure" }
  | { readonly status: "success"; readonly detail: ParsedActivityDetail };

function formatStructuredValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatActivityDetailForCopy(detail: ParsedActivityDetail): string {
  const blocks: string[] = [];
  for (const section of detail.sections) {
    blocks.push(section.title);
    for (const block of section.blocks) {
      if (block.kind === "text") {
        blocks.push(block.text);
      } else if (block.kind === "structured") {
        blocks.push(formatStructuredValue(block.value));
      } else {
        blocks.push(`[Image: ${block.alt}]`);
      }
    }
  }
  return blocks.filter((block) => block.trim().length > 0).join("\n\n");
}

function ToolActivityDetailImage(props: {
  readonly block: Extract<ActivityDetailBlock, { readonly kind: "image" }>;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const sourceIdentifier = useId();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [props.block.source]);

  return (
    <PresentationSource identifier={sourceIdentifier} style={{ alignSelf: "stretch" }}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={props.block.alt}
        onPress={() =>
          props.onPressPreview({
            kind: "image",
            uri: props.block.source,
            name: props.block.alt,
            sourceIdentifier,
          })
        }
        className="overflow-hidden rounded-[10px] bg-md-code-bg"
      >
        {failed ? (
          <View className="h-40 items-center justify-center">
            <Text className="text-xs text-foreground-muted">Image unavailable</Text>
          </View>
        ) : (
          <Image
            source={{ uri: props.block.source }}
            resizeMode="contain"
            onError={() => setFailed(true)}
            className="h-40 w-full"
            accessibilityLabel={props.block.alt}
          />
        )}
      </Pressable>
    </PresentationSource>
  );
}

function ToolActivityDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activityId: string;
  readonly onDetailLoaded: (activityId: string, detail: ParsedActivityDetail) => void;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const loadActivityDetail = useAtomQueryRunner(orchestrationEnvironment.activityDetail, {
    reportFailure: false,
    reportDefect: false,
  });
  const [state, setState] = useState<ToolActivityDetailState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    void loadActivityDetail({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        activityId: EventId.make(props.activityId),
      },
    }).then(
      (result) => {
        if (!active) return;
        if (result._tag === "Failure") {
          setState({ status: "failure" });
          return;
        }
        const detail = parseActivityDetail(result.value);
        setState({ status: "success", detail });
        props.onDetailLoaded(props.activityId, detail);
      },
      () => {
        if (active) setState({ status: "failure" });
      },
    );
    return () => {
      active = false;
    };
  }, [
    loadActivityDetail,
    props.activityId,
    props.environmentId,
    props.onDetailLoaded,
    props.threadId,
  ]);

  if (state.status === "loading") {
    return (
      <View className="flex-row items-center gap-2 py-1">
        <ActivityIndicator size="small" />
        <Text accessibilityRole="text" className="text-xs text-foreground-muted">
          Loading full tool details…
        </Text>
      </View>
    );
  }
  if (state.status === "failure") {
    return (
      <Text accessibilityRole="alert" className="py-1 text-xs text-adaptive-rose-600-400">
        Could not load full tool details.
      </Text>
    );
  }

  return (
    <ScrollView
      nestedScrollEnabled
      directionalLockEnabled
      showsVerticalScrollIndicator
      className="max-h-60"
      contentContainerStyle={{ gap: 12, paddingRight: 8 }}
    >
      {state.detail.sections.map((section, sectionIndex) => (
        <View key={`${section.title}-${sectionIndex}`} className="gap-1">
          <Text className="font-t3-medium text-xs text-foreground-muted">{section.title}</Text>
          {section.blocks.map((block, blockIndex) =>
            block.kind === "image" ? (
              <ToolActivityDetailImage
                key={`${sectionIndex}-${blockIndex}`}
                block={block}
                onPressPreview={props.onPressPreview}
              />
            ) : (
              <Text
                key={`${sectionIndex}-${blockIndex}`}
                selectable
                className="font-mono text-2xs leading-normal text-foreground-muted"
              >
                {block.kind === "text" ? block.text : formatStructuredValue(block.value)}
              </Text>
            ),
          )}
        </View>
      ))}
    </ScrollView>
  );
}

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): AppSymbolName {
  switch (icon) {
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "alert":
      return { ios: "exclamationmark.triangle", android: "error" };
    case "check":
      return { ios: "checkmark", android: "check" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "eye":
      return { ios: "eye", android: "visibility" };
    case "globe":
      return { ios: "globe", android: "public" };
    case "hammer":
      return { ios: "hammer", android: "construction" };
    case "message":
      return { ios: "bubble.left", android: "chat_bubble" };
    case "warning":
      return { ios: "xmark", android: "close" };
    case "wrench":
      return { ios: "wrench", android: "build" };
    case "zap":
      return { ios: "bolt", android: "bolt" };
  }
}

// Entering fades only for rows created moments ago: rows remount whenever the
// list scrolls them back into view, and old rows must not replay an entrance.
const FRESH_ROW_WINDOW_MS = 3_000;
function isFreshRow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ROW_WINDOW_MS;
}

// Pre-measurement heights for the feed's getFixedItemSize. Collapsed work-log
// rows are single-line (numberOfLines={1}) inside a min-height that stays
// taller than text-sm at every supported base font size, so row height is
// deterministic. Values mirror the classNames below. A mismatch only costs a
// one-time correction on measure.
const WORK_ROW_HEIGHT = 32; // min-h-8
const WORK_ROW_GAP = 1; // gap-px
const WORK_LOG_BOTTOM_MARGIN = 4; // mb-1

export const WORK_GROUP_TOGGLE_HEIGHT = 36; // min-h-8 (32) + mb-1 (4)

export function collapsedWorkLogHeight(activities: ReadonlyArray<ThreadFeedActivity>): number {
  const rows = activities;
  if (rows.length === 0) {
    return 0;
  }
  return WORK_LOG_BOTTOM_MARGIN + rows.length * WORK_ROW_HEIGHT + (rows.length - 1) * WORK_ROW_GAP;
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly copiedRowId: string | null;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly iconSubtleColor: ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string) => void;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const [loadedDetails, setLoadedDetails] = useState<
    Readonly<Record<string, ParsedActivityDetail>>
  >({});
  const onDetailLoaded = useCallback((activityId: string, detail: ParsedActivityDetail) => {
    setLoadedDetails((current) => ({ ...current, [activityId]: detail }));
  }, []);
  useEffect(() => {
    setLoadedDetails({});
  }, [props.environmentId, props.threadId]);

  const rows = props.activities.map((activity) => ({
    ...activity,
    detail: compactActivityDetail(activity.detail),
  }));

  if (rows.length === 0) {
    return null;
  }

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      <View className="gap-px">
        {rows.map((row) => {
          const expanded = props.expandedRows[row.id] ?? false;
          const canExpand = row.canExpand || row.toolLike;
          const fullDetail = expanded && !row.toolLike ? row.getFullDetail() : null;
          const loadedDetail = row.toolLike ? loadedDetails[row.id] : undefined;
          const fullCopyText =
            loadedDetail === undefined
              ? null
              : [row.getCopyText(), formatActivityDetailForCopy(loadedDetail)]
                  .filter(
                    (value, index, values) => value.length > 0 && values.indexOf(value) === index,
                  )
                  .join("\n\n");
          const displayText = row.detail ?? row.summary;
          const iconIsDestructive = row.icon === "alert" || row.icon === "warning";
          const failed = row.status === "failure";
          const showIcon = !row.groupedToolDetail || iconIsDestructive || failed;

          return (
            <Animated.View
              key={row.id}
              layout={WORK_LOG_LAYOUT_TRANSITION}
              className="overflow-hidden"
              {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
            >
              <Pressable
                accessibilityRole={canExpand ? "button" : undefined}
                accessibilityLabel={failed ? `${displayText}, tool call failed` : displayText}
                accessibilityHint={
                  canExpand
                    ? "Double tap to show full details. Long press to copy."
                    : "Long press to copy."
                }
                accessibilityState={canExpand ? { expanded } : undefined}
                hitSlop={4}
                onPress={() => {
                  if (canExpand) {
                    void Haptics.selectionAsync();
                    props.onToggleRow(row.id);
                  }
                }}
                onLongPress={() => props.onCopyRow(row.id, fullCopyText ?? row.getCopyText())}
                className="rounded-md px-0.5 py-0 active:bg-subtle"
              >
                <View className="min-h-8 flex-row items-center gap-1.5">
                  {row.live ? (
                    <ShimmeringWorkContent
                      icon={workRowSymbolName(row.icon)}
                      iconSubtleColor={props.iconSubtleColor}
                      label={displayText}
                      showIcon={showIcon}
                    />
                  ) : (
                    <>
                      <View className="h-6 w-6 shrink-0 items-center justify-center">
                        {showIcon ? (
                          <SymbolView
                            name={
                              failed
                                ? { ios: "xmark", android: "close" }
                                : workRowSymbolName(row.icon)
                            }
                            size={14}
                            weight="medium"
                            tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
                            type="monochrome"
                          />
                        ) : null}
                      </View>
                      <Text
                        className={cn(
                          "min-w-0 flex-1 text-sm text-foreground-muted",
                          iconIsDestructive && "font-t3-medium text-adaptive-rose-600-400",
                        )}
                        numberOfLines={1}
                      >
                        {displayText}
                      </Text>
                    </>
                  )}

                  <View className="shrink-0 flex-row items-center gap-px">
                    {props.copiedRowId === row.id ? (
                      <Text className="pr-1 font-t3-medium text-3xs text-adaptive-emerald-600-400">
                        Copied
                      </Text>
                    ) : null}
                    <View className="h-4 w-4 items-center justify-center">
                      {canExpand ? (
                        <SymbolView
                          name={
                            expanded
                              ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                              : { ios: "chevron.down", android: "keyboard_arrow_down" }
                          }
                          size={11}
                          tintColor={props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                  </View>
                </View>
              </Pressable>

              {expanded && row.toolLike ? (
                <Animated.View
                  entering={WORK_LOG_DETAIL_ENTER_TRANSITION}
                  exiting={WORK_LOG_DETAIL_EXIT_TRANSITION}
                  layout={WORK_LOG_LAYOUT_TRANSITION}
                  className="ml-7 border-l border-adaptive-neutral-300-a60-white-a12 pb-1 pl-3 pt-0.5"
                >
                  <ToolActivityDetail
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    activityId={row.id}
                    onDetailLoaded={onDetailLoaded}
                    onPressPreview={props.onPressPreview}
                  />
                </Animated.View>
              ) : fullDetail ? (
                <Animated.View
                  entering={WORK_LOG_DETAIL_ENTER_TRANSITION}
                  exiting={WORK_LOG_DETAIL_EXIT_TRANSITION}
                  layout={WORK_LOG_LAYOUT_TRANSITION}
                  className="ml-7 border-l border-adaptive-neutral-300-a60-white-a12 pb-1 pl-3 pt-0.5"
                >
                  <ScrollView
                    nestedScrollEnabled
                    directionalLockEnabled
                    showsVerticalScrollIndicator
                    className="max-h-60"
                    contentContainerStyle={{ paddingRight: 8 }}
                  >
                    <Text
                      selectable
                      className="font-mono text-2xs leading-normal text-foreground-muted"
                    >
                      {fullDetail}
                    </Text>
                  </ScrollView>
                </Animated.View>
              ) : null}
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

export function ThreadWorkGroupToggle(props: {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly summary: string;
  readonly summaryKind: ToolGroupSummaryKind;
  readonly hasFailure: boolean;
  readonly shimmer: boolean;
  readonly onToggle: () => void;
}) {
  const accessibilityLabel = props.hasFailure
    ? `${props.summary}, tool call failed`
    : props.summary;
  const icon = toolGroupSummarySymbolName(props.summaryKind);

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={`Double tap to ${props.expanded ? "hide" : "show"} ${props.hiddenCount} tool ${props.hiddenCount === 1 ? "call" : "calls"}.`}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        className="min-h-8 flex-row items-center gap-1.5 rounded-md px-0.5 py-0 active:bg-subtle"
      >
        {props.shimmer ? (
          <ShimmeringWorkContent
            icon={icon}
            iconSubtleColor={props.iconSubtleColor}
            label={props.summary}
            showIcon
          />
        ) : (
          <>
            <View className="h-6 w-6 items-center justify-center">
              <SymbolView
                name={icon}
                size={14}
                tintColor={props.iconSubtleColor}
                type="monochrome"
              />
            </View>
            <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
              {props.summary}
            </Text>
          </>
        )}
        <SymbolView
          name={
            props.expanded
              ? { ios: "chevron.up", android: "keyboard_arrow_up" }
              : { ios: "chevron.down", android: "keyboard_arrow_down" }
          }
          size={11}
          tintColor={props.iconSubtleColor}
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}

function toolGroupSummarySymbolName(kind: ToolGroupSummaryKind): AppSymbolName {
  switch (kind) {
    case "read":
      return { ios: "eye", android: "visibility" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "search":
      return { ios: "globe", android: "public" };
    case "code-search":
      return "magnifyingglass";
    case "other":
      return { ios: "wrench", android: "build" };
    case "agent-tool":
      return { ios: "sparkles", android: "auto_awesome" };
    case "tone-tool":
      return { ios: "bolt", android: "bolt" };
    case "dynamic-tool":
    case "update":
    case "mixed":
      return { ios: "hammer", android: "construction" };
  }
}
