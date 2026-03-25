import type { MutableRefObject } from 'react';

import type { Message, Part } from '@opencode-ai/sdk/v2';

import { opencodeClient } from '@/lib/opencode/client';
import { saveSessionCursor } from '@/lib/messageCursorPersistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { useMessageStore } from '@/stores/messageStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { streamDebugEnabled, streamPerfCount, streamPerfMeasure, streamPerfObserve } from '@/stores/utils/streamDebug';

type EventData = {
  type: string;
  properties?: Record<string, unknown>;
};

type MessageRecord = { info: Message; parts: Part[] } | null;

type ContentLaneDependencies = {
  currentSessionId: string | null;
  readStringProp: (obj: unknown, keys: string[]) => string | null;
  readEventDirectory: (props: Record<string, unknown>) => string;
  getMessageFromStore: (sessionId: string, messageId: string) => MessageRecord;
  getLatestMessageFromStore: (sessionId: string, messageId: string) => MessageRecord;
  addStreamingPart: (sessionId: string, messageId: string, part: Part, role?: string) => void;
  applyPartDelta: (sessionId: string, messageId: string, partId: string, field: string, delta: string, role?: string) => void;
  completeStreamingMessage: (sessionId: string, messageId: string) => void;
  updateMessageInfo: (sessionId: string, messageId: string, messageInfo: Message) => void;
  updateSessionCompaction: (sessionId: string, compactingAt: number | null) => void;
  trackMessage: (messageId: string, event?: string, extraData?: Record<string, unknown>) => void;
  reportMessage: (messageId: string) => void;
  writePartTypeHint: (key: string, type: string) => void;
  emitGitRefreshHint: (payload: {
    directory: string;
    sessionId: string;
    messageId: string;
    partId?: string | null;
    toolName: string;
    toolState: string;
  }) => void;
  requestPendingQuestionsRefresh: () => void;
  markSessionBusyFromContentEvent: (sessionId: string, source: 'sse:message.part.updated' | 'sse:message.part.delta') => void;
  requestSessionMetadataRefresh: (sessionId: string, directory: string | null) => void;
  repairSessionDerivedState: (reason: string, options?: { refreshActivity?: boolean; pollStatus?: boolean; immediate?: boolean }) => void;
  dispatchRuntimeNotification: (payload: { title: string; body: string; tag?: string }) => void;
  scheduleSideEffect: (effect: () => void) => void;
  currentSessionIdRef: MutableRefObject<string | null>;
  lastUserAgentSelectionRef: MutableRefObject<Map<string, { created: number; messageId: string }>>;
  missingMessageHydrationRef: MutableRefObject<Set<string>>;
  modeSwitchToastShownRef: MutableRefObject<Set<string>>;
  notifiedMessagesRef: MutableRefObject<Set<string>>;
  partTypeHintsByKeyRef: MutableRefObject<Map<string, string>>;
  pendingMessageStallTimersRef: MutableRefObject<Map<string, NodeJS.Timeout>>;
  lastMessageEventBySessionRef: MutableRefObject<Map<string, number>>;
  serverNotificationEventSeenRef: MutableRefObject<boolean>;
  gitRefreshHintToolNames: Set<string>;
  gitRefreshHintCompletedStates: Set<string>;
};

const keepSyntheticUserText = (value: unknown): boolean => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return false;
  return (
    text.startsWith('User has requested to enter plan mode') ||
    text.startsWith('The plan at ') ||
    text.startsWith('The following tool was executed by the user')
  );
};

const clearPendingStallTimer = (
  pendingMessageStallTimersRef: MutableRefObject<Map<string, NodeJS.Timeout>>,
  sessionId: string,
) => {
  const pendingTimer = pendingMessageStallTimersRef.current.get(sessionId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingMessageStallTimersRef.current.delete(sessionId);
  }
};

const handleMessagePartUpdated = (props: Record<string, unknown>, deps: ContentLaneDependencies): boolean => {
  const part = (typeof props.part === 'object' && props.part !== null) ? (props.part as Part) : null;
  if (!part) return true;

  const partExt = part as Record<string, unknown>;
  const messageInfo = (typeof props.info === 'object' && props.info !== null) ? (props.info as Record<string, unknown>) : props;
  const messageInfoSessionId = deps.readStringProp(messageInfo, ['sessionID', 'sessionId']);

  const sessionId =
    deps.readStringProp(partExt, ['sessionID', 'sessionId']) ||
    messageInfoSessionId ||
    deps.readStringProp(props, ['sessionID', 'sessionId']);
  const messageInfoId = deps.readStringProp(messageInfo, ['messageID', 'messageId', 'id']);
  const messageId =
    deps.readStringProp(partExt, ['messageID', 'messageId']) ||
    messageInfoId ||
    deps.readStringProp(props, ['messageID', 'messageId']);

  if (!sessionId || !messageId) {
    if (streamDebugEnabled()) {
      console.debug('[useEventStream] Skipping message.part.updated without resolvable session/message id', {
        sessionID: partExt.sessionID ?? messageInfoSessionId ?? props.sessionID,
        messageID: partExt.messageID ?? messageInfoId ?? props.messageID,
      });
    }
    return true;
  }

  deps.lastMessageEventBySessionRef.current.set(sessionId, Date.now());
  clearPendingStallTimer(deps.pendingMessageStallTimersRef, sessionId);

  const liveStreamingMessageId = useSessionStore.getState().streamingMessageIds.get(sessionId) ?? null;
  if (
    typeof liveStreamingMessageId === 'string'
    && liveStreamingMessageId.length > 0
    && liveStreamingMessageId !== messageId
  ) {
    streamPerfCount('ui.event_stream.message_updated_dropped_non_active');
    return true;
  }

  const inferUserRoleFromPart = (): boolean => {
    const partType = typeof partExt.type === 'string' ? partExt.type : '';
    if (partType === 'subtask' || partType === 'agent' || partType === 'file') {
      return true;
    }
    if (partType === 'text' && partExt.synthetic === true) {
      return keepSyntheticUserText((partExt as { text?: unknown }).text);
    }
    return false;
  };

  let roleInfo = 'assistant';
  const existingMessage = deps.getLatestMessageFromStore(sessionId, messageId);
  const existingPartForType = existingMessage?.parts?.find((item) => item?.id === partExt.id);
  const existingPartType = typeof (existingPartForType as { type?: unknown } | undefined)?.type === 'string'
    ? (existingPartForType as { type: string }).type
    : undefined;

  if (typeof (messageInfo as { role?: unknown }).role === 'string') {
    roleInfo = (messageInfo as { role: string }).role;
  } else {
    const existingRole = (existingMessage?.info as Record<string, unknown> | undefined)?.role;
    if (typeof existingRole === 'string') {
      roleInfo = existingRole;
    }
  }

  if (roleInfo !== 'user' && inferUserRoleFromPart()) {
    roleInfo = 'user';
  }

  deps.trackMessage(messageId, 'part_received', { role: roleInfo });

  if (roleInfo === 'user' && partExt.synthetic === true && !keepSyntheticUserText((partExt as { text?: unknown }).text)) {
    deps.trackMessage(messageId, 'skipped_synthetic_user_part');
    return true;
  }

  const updatedPartId = deps.readStringProp(partExt, ['id', 'partID', 'partId']);
  const directory = deps.readEventDirectory(props);
  const partTypeHintKey = updatedPartId ? `${directory}:${messageId}:${updatedPartId}` : null;
  const hintedPartType = partTypeHintKey ? deps.partTypeHintsByKeyRef.current.get(partTypeHintKey) : undefined;
  const resolvedPartType = part.type || existingPartType || hintedPartType || 'text';
  const messagePart: Part = { ...part, type: resolvedPartType } as Part;

  if (partTypeHintKey && typeof resolvedPartType === 'string' && resolvedPartType.length > 0) {
    deps.writePartTypeHint(partTypeHintKey, resolvedPartType);
  }

  if (roleInfo === 'assistant') {
    const partType = (messagePart as { type?: unknown }).type;
    const partTime = (messagePart as { time?: { end?: unknown } }).time;
    const partHasEnded = typeof partTime?.end === 'number';
    const toolState = (messagePart as { state?: { status?: unknown } }).state?.status;
    const normalizedToolState = typeof toolState === 'string' ? toolState.toLowerCase() : null;
    const toolName = typeof (messagePart as { tool?: unknown }).tool === 'string'
      ? (messagePart as { tool: string }).tool.toLowerCase()
      : null;
    const textContent = (messagePart as { text?: unknown }).text;

    if (
      partType === 'tool' &&
      toolName &&
      deps.gitRefreshHintToolNames.has(toolName) &&
      normalizedToolState &&
      deps.gitRefreshHintCompletedStates.has(normalizedToolState)
    ) {
      deps.scheduleSideEffect(() => {
        deps.emitGitRefreshHint({
          directory,
          sessionId,
          messageId,
          partId: updatedPartId,
          toolName,
          toolState: normalizedToolState,
        });
      });
    }

    if (partType === 'tool' && toolName === 'question') {
      deps.scheduleSideEffect(() => deps.requestPendingQuestionsRefresh());
    }

    const isStreamingPart = (() => {
      if (partType === 'tool') return normalizedToolState === 'running' || normalizedToolState === 'pending';
      if (partType === 'reasoning') return !partHasEnded;
      if (partType === 'text') return typeof textContent === 'string' && textContent.trim().length > 0 && !partHasEnded;
      if (partType === 'step-start') return true;
      return false;
    })();

    if (isStreamingPart) {
      deps.markSessionBusyFromContentEvent(sessionId, 'sse:message.part.updated');
    }
  }

  deps.trackMessage(messageId, 'addStreamingPart_called');
  streamPerfCount('ui.event_stream.message_part_updated');
  streamPerfMeasure('ui.event_stream.add_streaming_part_ms', () => {
    deps.addStreamingPart(sessionId, messageId, messagePart, roleInfo);
  });
  return true;
};

const handleMessagePartDelta = (props: Record<string, unknown>, deps: ContentLaneDependencies): boolean => {
  const sessionId = deps.readStringProp(props, ['sessionID', 'sessionId']);
  const messageId = deps.readStringProp(props, ['messageID', 'messageId']);
  const partId = deps.readStringProp(props, ['partID', 'partId']);
  const field = deps.readStringProp(props, ['field']);
  const delta = typeof props.delta === 'string' ? props.delta : null;

  if (!sessionId || !messageId || !partId || !field || delta === null) {
    if (streamDebugEnabled()) {
      console.debug('[useEventStream] Skipping message.part.delta with missing payload', {
        sessionID: props.sessionID,
        messageID: props.messageID,
        partID: props.partID,
        field: props.field,
      });
    }
    return true;
  }

  deps.lastMessageEventBySessionRef.current.set(sessionId, Date.now());
  clearPendingStallTimer(deps.pendingMessageStallTimersRef, sessionId);

  const existingMessage = deps.getLatestMessageFromStore(sessionId, messageId);
  const existingPart = existingMessage?.parts?.find((item) => item?.id === partId);
  const existingRole = (existingMessage?.info as Record<string, unknown> | undefined)?.role;
  const roleInfo = typeof existingRole === 'string' ? existingRole : 'assistant';

  if (!existingPart) {
    if (field === 'text' || field === 'content' || field === 'value') {
      const directory = deps.readEventDirectory(props);
      const deltaPartTypeHint =
        deps.readStringProp(props, ['partType', 'type', 'part_type']) ||
        deps.readStringProp(props, ['kind']);
      const partTypeHintKey = `${directory}:${messageId}:${partId}`;
      const hintedPartType = deps.partTypeHintsByKeyRef.current.get(partTypeHintKey);
      const bootstrappedPartType =
        typeof deltaPartTypeHint === 'string' && deltaPartTypeHint.trim().length > 0
          ? deltaPartTypeHint
          : (typeof hintedPartType === 'string' && hintedPartType.trim().length > 0 ? hintedPartType : 'text');

      const bootstrappedPart = {
        id: partId,
        type: bootstrappedPartType,
        sessionID: sessionId,
        messageID: messageId,
        delta,
        [field]: '',
      } as unknown as Part;

      if (typeof bootstrappedPartType === 'string' && bootstrappedPartType.length > 0) {
        deps.writePartTypeHint(partTypeHintKey, bootstrappedPartType);
      }

      deps.addStreamingPart(sessionId, messageId, bootstrappedPart, roleInfo);
    }
    return true;
  }

  if (roleInfo === 'assistant' && delta.length > 0) {
    deps.markSessionBusyFromContentEvent(sessionId, 'sse:message.part.delta');
  }

  deps.trackMessage(messageId, 'part_delta_received', { role: roleInfo, field });
  streamPerfCount('ui.event_stream.message_part_delta');
  streamPerfObserve('ui.event_stream.message_part_delta_chars', delta.length);
  streamPerfMeasure('ui.event_stream.apply_part_delta_ms', () => {
    deps.applyPartDelta(sessionId, messageId, partId, field, delta, roleInfo);
  });
  return true;
};

const handleMessageUpdated = (props: Record<string, unknown>, deps: ContentLaneDependencies): boolean => {
  const message = (typeof props.info === 'object' && props.info !== null) ? (props.info as Record<string, unknown>) : props;
  const messageExt = message as Record<string, unknown>;
  const sessionId =
    deps.readStringProp(messageExt, ['sessionID', 'sessionId']) ||
    deps.readStringProp(props, ['sessionID', 'sessionId']);
  const messageId =
    deps.readStringProp(messageExt, ['messageID', 'messageId', 'id']) ||
    deps.readStringProp(props, ['messageID', 'messageId']);

  if (!sessionId || !messageId) {
    if (streamDebugEnabled()) {
      console.debug('[useEventStream] Skipping message.updated without resolvable session/message id', {
        sessionID: messageExt.sessionID ?? props.sessionID,
        messageID: messageExt.id ?? props.messageID,
      });
    }
    return true;
  }

  deps.lastMessageEventBySessionRef.current.set(sessionId, Date.now());
  clearPendingStallTimer(deps.pendingMessageStallTimersRef, sessionId);

  if (streamDebugEnabled()) {
    try {
      const serverParts = (props as { parts?: unknown }).parts || (messageExt as { parts?: unknown }).parts || [];
      const textParts = Array.isArray(serverParts)
        ? serverParts.filter((p: unknown) => (p as { type?: string })?.type === 'text')
        : [];
      const textJoined = textParts
        .map((p: unknown) => {
          const part = p as { text?: string; content?: string };
          return typeof part?.text === 'string' ? part.text : typeof part?.content === 'string' ? part.content : '';
        })
        .join('\n');
      console.info('[STREAM-TRACE] message.updated', {
        messageId,
        role: (messageExt as { role?: unknown }).role,
        status: (messageExt as { status?: unknown }).status,
        textLen: textJoined.length,
        textPreview: textJoined.slice(0, 120),
        partsCount: Array.isArray(serverParts) ? serverParts.length : 0,
      });
    } catch {
      // ignored
    }
  }

  deps.trackMessage(messageId, 'message_updated', { role: (messageExt as { role?: unknown }).role });

  if ((messageExt as { role?: unknown }).role === 'user') {
    deps.scheduleSideEffect(() => {
      const { sessionMemoryState } = useMessageStore.getState();
      const currentMemory = sessionMemoryState.get(sessionId);
      if (!currentMemory) return;
      const newMemoryState = new Map(sessionMemoryState);
      newMemoryState.set(sessionId, {
        ...currentMemory,
        lastUserMessageAt: Date.now(),
      });
      useMessageStore.setState({ sessionMemoryState: newMemoryState });
    });

    const serverParts = (props as { parts?: unknown }).parts || (messageExt as { parts?: unknown }).parts;
    const partsArray = Array.isArray(serverParts) ? (serverParts as Part[]) : [];
    const existingUserMessage = deps.getMessageFromStore(sessionId, messageId);

    const agentCandidate = (() => {
      const rawAgent = (messageExt as { agent?: unknown }).agent;
      if (typeof rawAgent === 'string' && rawAgent.trim().length > 0) return rawAgent.trim();
      const rawMode = (messageExt as { mode?: unknown }).mode;
      if (typeof rawMode === 'string' && rawMode.trim().length > 0) return rawMode.trim();
      return '';
    })();

    const createdAt = (() => {
      const rawTime = (messageExt as { time?: unknown }).time as { created?: unknown } | undefined;
      const created = rawTime?.created;
      return typeof created === 'number' ? created : null;
    })();

    const isSyntheticOnly = partsArray.length > 0 && partsArray.every((part) => (part as { synthetic?: boolean })?.synthetic === true);

    const shouldApplyUserAgentSelection = (() => {
      if (!agentCandidate) return false;
      if (isSyntheticOnly && (agentCandidate === 'plan' || agentCandidate === 'build')) return true;

      if (deps.currentSessionIdRef.current === sessionId) {
        const explicitSelection = useContextStore.getState().getSessionAgentSelection(sessionId);
        if (explicitSelection && explicitSelection !== agentCandidate) {
          const status = useSessionStore.getState().sessionStatus?.get(sessionId);
          const isBusy = status?.type === 'busy' || status?.type === 'retry';
          if (isBusy) return false;
        }
      }

      const last = deps.lastUserAgentSelectionRef.current.get(sessionId);
      if (!last) return true;
      if (createdAt === null) return false;
      if (messageId === last.messageId) return true;
      return createdAt >= last.created;
    })();

    if (agentCandidate && shouldApplyUserAgentSelection) {
      deps.scheduleSideEffect(() => {
        try {
          const agents = useConfigStore.getState().agents;
          if (!Array.isArray(agents) || !agents.some((agent) => agent?.name === agentCandidate)) {
            return;
          }

          const context = useContextStore.getState();
          context.saveSessionAgentSelection(sessionId, agentCandidate);
          deps.lastUserAgentSelectionRef.current.set(sessionId, { created: createdAt ?? Date.now(), messageId });

          if (deps.currentSessionIdRef.current === sessionId) {
            try {
              useConfigStore.getState().setAgent(agentCandidate);
            } catch {
              // ignored
            }
          }

          const modelObj = (messageExt as { model?: { providerID?: unknown; modelID?: unknown } }).model;
          const providerID = typeof modelObj?.providerID === 'string' ? modelObj.providerID : null;
          const modelID = typeof modelObj?.modelID === 'string' ? modelObj.modelID : null;
          if (providerID && modelID) {
            context.saveSessionModelSelection(sessionId, providerID, modelID);
            context.saveAgentModelForSession(sessionId, agentCandidate, providerID, modelID);
            const variant = typeof (messageExt as { variant?: unknown }).variant === 'string'
              ? (messageExt as { variant: string }).variant
              : undefined;
            context.saveAgentModelVariantForSession(sessionId, agentCandidate, providerID, modelID, variant);

            if (deps.currentSessionIdRef.current === sessionId) {
              try {
                useConfigStore.getState().setProvider(providerID);
                useConfigStore.getState().setModel(modelID);
              } catch {
                // ignored
              }
            }
          }
        } catch {
          // ignored
        }
      });
    }

    if (isSyntheticOnly && (agentCandidate === 'plan' || agentCandidate === 'build') && deps.currentSessionIdRef.current === sessionId) {
      const toastKey = `${sessionId}:${messageId}:${agentCandidate}`;
      if (!deps.modeSwitchToastShownRef.current.has(toastKey)) {
        deps.modeSwitchToastShownRef.current.add(toastKey);
        deps.scheduleSideEffect(() => {
          import('sonner').then(({ toast }) => {
            toast.info(agentCandidate === 'plan' ? 'Plan mode active' : 'Build mode active', {
              description: agentCandidate === 'plan' ? 'Edits restricted to plan file' : 'You can now edit files',
              duration: 5000,
            });
          });
        });
      }
    }

    const userMessageInfo = {
      ...message,
      userMessageMarker: true,
      clientRole: 'user',
      ...(agentCandidate ? { mode: agentCandidate } : {}),
    } as unknown as Message;
    deps.updateMessageInfo(sessionId, messageId, userMessageInfo);

    if (!existingUserMessage && partsArray.length === 0) {
      const hydrateKey = `${sessionId}:${messageId}`;
      if (!deps.missingMessageHydrationRef.current.has(hydrateKey)) {
        deps.missingMessageHydrationRef.current.add(hydrateKey);
        deps.scheduleSideEffect(() => {
          void opencodeClient
            .getSessionMessages(sessionId)
            .then((messages) => {
              useSessionStore.getState().syncMessages(sessionId, messages);
            })
            .catch(() => {
              // ignored
            });
        });
      }
    }

    if (partsArray.length > 0) {
      const directory = deps.readEventDirectory(props);
      for (const serverPart of partsArray) {
        const isSynthetic = (serverPart as Record<string, unknown>).synthetic === true;
        if (isSynthetic && !keepSyntheticUserText((serverPart as { text?: unknown }).text)) {
          continue;
        }

        const enrichedPart: Part = {
          ...serverPart,
          type: serverPart?.type || 'text',
          sessionID: (serverPart as { sessionID?: string })?.sessionID || sessionId,
          messageID: (serverPart as { messageID?: string })?.messageID || messageId,
        } as Part;
        if (typeof enrichedPart.id === 'string' && typeof enrichedPart.type === 'string') {
          deps.writePartTypeHint(`${directory}:${messageId}:${enrichedPart.id}`, enrichedPart.type);
        }
        deps.addStreamingPart(sessionId, messageId, enrichedPart, 'user');
      }
    }

    deps.trackMessage(messageId, 'user_message_created_from_event', { partsCount: partsArray.length });
    return true;
  }

  const existingMessage = deps.getMessageFromStore(sessionId, messageId);
  const existingStopMarker = (existingMessage?.info as { finish?: string } | undefined)?.finish === 'stop';
  const serverParts = (props as { parts?: unknown }).parts || (messageExt as { parts?: unknown }).parts;
  const partsArray = Array.isArray(serverParts) ? (serverParts as Part[]) : [];
  const hasParts = partsArray.length > 0;
  const timeObj = (messageExt as { time?: { completed?: number } }).time || {};
  const completedFromServer = typeof timeObj?.completed === 'number';
  const rawStatus = (message as { status?: unknown }).status;
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : null;
  const hasCompletedStatus = status === 'completed' || status === 'complete';
  const finishCandidate = (message as { finish?: unknown }).finish;
  const finish = typeof finishCandidate === 'string' ? finishCandidate : null;
  const eventHasStopFinish = finish === 'stop';
  const eventHasErrorFinish = finish === 'error';

  if (!hasParts && !completedFromServer && !hasCompletedStatus && !eventHasStopFinish && !eventHasErrorFinish) {
    return true;
  }

  const messageInfoOnly = { ...messageExt } as Record<string, unknown>;
  delete messageInfoOnly.parts;
  deps.updateMessageInfo(sessionId, messageId, messageInfoOnly as unknown as Message);

  const messageRole = typeof (message as { role?: unknown }).role === 'string' ? (message as { role: string }).role : null;
  const runtimeAPIs = getRegisteredRuntimeAPIs();
  const shouldSynthesizeNotifications = Boolean(runtimeAPIs?.runtime?.isVSCode) && !deps.serverNotificationEventSeenRef.current;
  if (shouldSynthesizeNotifications && messageRole === 'assistant') {
    deps.scheduleSideEffect(() => {
      const settings = useUIStore.getState();
      const sessionInfo = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId);
      const sessionTitle = typeof sessionInfo?.title === 'string' ? sessionInfo.title.trim() : '';

      if (eventHasStopFinish && settings.notifyOnCompletion !== false) {
        const isSubtask = Boolean(sessionInfo?.parentID);
        if (!(settings.notifyOnSubtasks === false && isSubtask)) {
          const notificationKey = `ready:${sessionId}:${messageId}`;
          if (!deps.notifiedMessagesRef.current.has(notificationKey)) {
            deps.notifiedMessagesRef.current.add(notificationKey);
            deps.dispatchRuntimeNotification({
              title: 'Agent is ready',
              body: sessionTitle || 'Task completed',
              tag: `ready-${sessionId}`,
            });
          }
        }
      }

      if (eventHasErrorFinish && settings.notifyOnError !== false) {
        const notificationKey = `error:${sessionId}:${messageId}`;
        if (!deps.notifiedMessagesRef.current.has(notificationKey)) {
          deps.notifiedMessagesRef.current.add(notificationKey);
          deps.dispatchRuntimeNotification({
            title: 'Tool error',
            body: sessionTitle || 'An error occurred',
            tag: `error-${sessionId}`,
          });
        }
      }
    });
  }

  const messageTime = (message as { time?: { completed?: unknown } }).time;
  const completedCandidate = (messageTime as { completed?: unknown } | undefined)?.completed;
  const hasCompletedTimestamp = typeof completedCandidate === 'number' && Number.isFinite(completedCandidate);
  const stopMarkerPresent = finish === 'stop' || existingStopMarker;
  const shouldFinalizeAssistantMessage = (message as { role?: string }).role === 'assistant' && (hasCompletedTimestamp || hasCompletedStatus || stopMarkerPresent);

  if (shouldFinalizeAssistantMessage && (message as { role?: string }).role === 'assistant') {
    const storeState = useSessionStore.getState();
    const sessionMessages = storeState.messages.get(sessionId) || [];
    let latestAssistantMessageId: string | null = null;
    let maxId = '';
    for (const msg of sessionMessages) {
      if (msg.info.role === 'assistant' && msg.info.id > maxId) {
        maxId = msg.info.id;
        latestAssistantMessageId = msg.info.id;
      }
    }

    const isActiveSession = deps.currentSessionId === sessionId;
    if (isActiveSession && messageId !== latestAssistantMessageId) {
      return true;
    }

    const timeCompleted = hasCompletedTimestamp ? (completedCandidate as number) : Date.now();
    if (!hasCompletedTimestamp) {
      deps.updateMessageInfo(sessionId, messageId, {
        ...message,
        time: { ...(messageTime ?? {}), completed: timeCompleted },
      } as unknown as Message);
    }

    deps.trackMessage(messageId, 'completed', { timeCompleted });
    deps.reportMessage(messageId);
    deps.completeStreamingMessage(sessionId, messageId);

    deps.scheduleSideEffect(() => {
      void saveSessionCursor(sessionId, messageId, timeCompleted);
      deps.repairSessionDerivedState('assistant_message_completed');

      const rawMessageSessionId = (message as { sessionID?: string }).sessionID;
      const messageSessionId = typeof rawMessageSessionId === 'string' && rawMessageSessionId.length > 0
        ? rawMessageSessionId
        : sessionId;

      deps.requestSessionMetadataRefresh(
        messageSessionId,
        typeof props.directory === 'string' ? props.directory : null,
      );

      const summaryInfo = message as Message & { summary?: boolean };
      if (summaryInfo.summary && typeof messageSessionId === 'string') {
        deps.updateSessionCompaction(messageSessionId, null);
      }
    });
  }

  return true;
};

export const createContentEventHandler = (deps: ContentLaneDependencies) => {
  return (event: EventData): boolean => {
    if (!event.properties) {
      return false;
    }

    const props = event.properties as Record<string, unknown>;
    switch (event.type) {
      case 'message.part.updated':
        return handleMessagePartUpdated(props, deps);
      case 'message.part.delta':
        return handleMessagePartDelta(props, deps);
      case 'message.updated':
        return handleMessageUpdated(props, deps);
      default:
        return false;
    }
  };
};
