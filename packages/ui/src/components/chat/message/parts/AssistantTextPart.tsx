import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { resolveAssistantDisplayText, shouldRenderAssistantText } from './assistantTextVisibility';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import { useSessionMessageRecords } from '@/sync/sync-context';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

interface AssistantTextPartProps {
    part: Part;
    sessionId?: string;
    messageId: string;
    streamPhase: StreamPhase;
    chatRenderMode?: 'sorted' | 'live';
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    sessionId,
    messageId,
    streamPhase,
    chatRenderMode = 'live',
}) => {
    const messageRecords = useSessionMessageRecords(sessionId ?? '');
    const livePart = React.useMemo(() => {
        if (!sessionId || typeof part.id !== 'string' || part.id.length === 0) {
            return null;
        }

        const message = messageRecords.find((entry) => entry.info.id === messageId);
        if (!message) {
            return null;
        }

        const match = message.parts.find((candidate: { id?: string }) => candidate?.id === part.id);
        return match ?? null;
    }, [messageRecords, messageId, part.id, sessionId]);

    const renderPart = livePart ?? part;
    const partWithText = renderPart as PartWithText;
    const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
    const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
    const valueText = typeof partWithText.value === 'string' ? partWithText.value : '';
    const textContent = [rawText, contentText, valueText].reduce((best, candidate) => {
        return candidate.length > best.length ? candidate : best;
    }, '');
    const isStreamingPhase = streamPhase === 'streaming';
    const isCooldownPhase = streamPhase === 'cooldown';
    const isStreaming = chatRenderMode === 'live' && (isStreamingPhase || isCooldownPhase);

    streamPerfCount('ui.assistant_text_part.render');
    if (isStreaming) {
        streamPerfCount('ui.assistant_text_part.render.streaming');
    }

    const throttledTextContent = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        identityKey: `${messageId}:${part.id ?? 'text'}`,
    });

    const displayTextContent = resolveAssistantDisplayText({
        textContent,
        throttledTextContent,
        isStreaming,
    });

    streamPerfObserve('ui.assistant_text_part.display_len', displayTextContent.length);

    const lastDisplayLengthRef = React.useRef(0);
    React.useEffect(() => {
        if (!isStreaming || typeof window === 'undefined') {
            lastDisplayLengthRef.current = displayTextContent.length;
            return;
        }
        const debugEnabled = window.localStorage.getItem('openchamber_stream_debug') === '1';
        if (!debugEnabled) {
            lastDisplayLengthRef.current = displayTextContent.length;
            return;
        }
        if (displayTextContent.length < lastDisplayLengthRef.current) {
            console.info('[STREAM-TRACE] render_shrink', {
                messageId,
                partId: part.id,
                rawTextLen: rawText.length,
                contentLen: contentText.length,
                valueLen: valueText.length,
                chosenLen: textContent.length,
                throttledLen: throttledTextContent.length,
                displayLen: displayTextContent.length,
                prevDisplayLen: lastDisplayLengthRef.current,
            });
        }
        lastDisplayLengthRef.current = displayTextContent.length;
    }, [contentText.length, displayTextContent.length, isStreaming, messageId, part.id, rawText.length, textContent.length, throttledTextContent.length, valueText.length]);

    const time = partWithText.time;
    const isFinalized = Boolean(time && typeof time.end !== 'undefined');

    const isRenderableTextPart = renderPart.type === 'text' || renderPart.type === 'reasoning';
    if (!isRenderableTextPart) {
        return null;
    }

    if (!shouldRenderAssistantText({
        displayTextContent,
        isFinalized,
    })) {
        return null;
    }

    return (
        <div
            className={`group/assistant-text relative break-words ${chatRenderMode === 'live' ? 'my-1' : ''}`}
            key={part.id || `${messageId}-text`}
        >
            <MarkdownRenderer
                content={displayTextContent}
                part={renderPart}
                messageId={messageId}
                isAnimated={false}
                isStreaming={isStreaming}
                disableStreamAnimation={chatRenderMode === 'sorted'}
                variant={renderPart.type === 'reasoning' ? 'reasoning' : 'assistant'}
            />
        </div>
    );
};

export default React.memo(AssistantTextPart, (prev, next) => {
    return prev.sessionId === next.sessionId
        && prev.messageId === next.messageId
        && prev.streamPhase === next.streamPhase
        && prev.chatRenderMode === next.chatRenderMode
        && prev.part.id === next.part.id
        && prev.part.type === next.part.type;
});
