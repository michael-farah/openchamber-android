/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useCallback, useMemo } from "react"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"
import type { StoreApi } from "zustand"
import { useStore } from "zustand"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "./event-pipeline"
import { reduceGlobalEvent, applyGlobalProject, applyDirectoryEvent } from "./event-reducer"
import { useGlobalSyncStore, type GlobalSyncStore } from "./global-sync-store"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { bootstrapGlobal, bootstrapDirectory } from "./bootstrap"
import { updateStreamingState } from "./streaming"
import { setActionRefs } from "./session-actions"
import { setSyncRefs } from "./sync-refs"
import { appendNotification } from "./notification-store"
import type { State } from "./types"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { PermissionRequest } from "@/types/permission"
import type { QuestionRequest } from "@/types/question"
import { create } from "zustand"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type SyncSystem = {
  childStores: ChildStoreManager
  sdk: OpencodeClient
  directory: string
}

const SyncContext = createContext<SyncSystem | null>(null)

function useSyncSystem() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSyncSystem must be used within <SyncProvider>")
  return ctx
}

// ---------------------------------------------------------------------------
// Event handler — applies one SSE event at a time to the live store.
// Each event reads live state, creates a shallow draft, applies, writes back.
// React 18 batches synchronous setState calls automatically.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Global session status store — cross-directory status tracking.
//
// OpenCode isolates sessions behind project navrails, so per-directory
// session_status is sufficient. OpenChamber shows all sessions in one sidebar,
// so we need a global view. Updated from handleEvent on every session.status.
// ---------------------------------------------------------------------------

interface GlobalSessionStatusStore {
  statuses: Record<string, SessionStatus>
}

const useGlobalSessionStatusStore = create<GlobalSessionStatusStore>(() => ({
  statuses: {},
}))

function setGlobalSessionStatus(sessionId: string, status: SessionStatus) {
  const current = useGlobalSessionStatusStore.getState().statuses
  if (current[sessionId] === status) return
  useGlobalSessionStatusStore.setState({
    statuses: { ...current, [sessionId]: status },
  })
}

/** Read status for a session across all directories */
export function useGlobalSessionStatus(sessionId: string): SessionStatus | undefined {
  return useGlobalSessionStatusStore((s) => s.statuses[sessionId])
}

/** Read all session statuses (for sidebar) */
export function useAllSessionStatuses(): Record<string, SessionStatus> {
  return useGlobalSessionStatusStore((s) => s.statuses)
}

// Boot debounce — suppresses redundant refresh/re-bootstrap events during startup.
let bootingRoot = false
let bootedAt = 0
const BOOT_DEBOUNCE_MS = 1500

// Module-level refs for notification viewed check.
// Used to determine if user is currently viewing the session when a notification arrives.
let _activeDirectory = ""
let _activeSession = ""

export function setActiveSession(directory: string, sessionId: string) {
  _activeDirectory = directory
  _activeSession = sessionId
}

function isViewedInCurrentSession(directory: string, sessionId?: string): boolean {
  if (!_activeDirectory || !_activeSession || !sessionId) return false
  if (directory !== _activeDirectory) return false
  return sessionId === _activeSession
}

function isRecentBoot() {
  return bootingRoot || Date.now() - bootedAt < BOOT_DEBOUNCE_MS
}

function handleEvent(
  directory: string,
  payload: Event,
  childStores: ChildStoreManager,
) {
  // Global events
  if (directory === "global" || !directory) {
    const recent = isRecentBoot()
    const result = reduceGlobalEvent(payload)
    if (!result) return
    if (result.type === "refresh") {
      // Suppress refresh during/shortly after bootstrap
      if (!recent) {
        useGlobalSyncStore.setState({ reload: "pending" })
      }
    } else if (result.type === "project") {
      const current = useGlobalSyncStore.getState()
      useGlobalSyncStore.setState({
        projects: applyGlobalProject(current, result.project).projects,
      })
    }
    // On server.connected / global.disposed, re-bootstrap all directories
    // but only if not during recent boot
    if (payload.type === "server.connected" || payload.type === "global.disposed") {
      if (!recent) {
        for (const dir of childStores.children.keys()) {
          const store = childStores.getChild(dir)
          if (store && store.getState().status !== "loading") {
            // Mark as loading to trigger re-bootstrap
            store.setState({ status: "loading" as const })
            childStores.ensureChild(dir)
          }
        }
      }
    }
    return
  }

  // Directory events
  const store = childStores.getChild(directory)
  if (!store) {
    // Try as global event for unknown directories
    const result = reduceGlobalEvent(payload)
    if (result?.type === "refresh") {
      useGlobalSyncStore.setState({ reload: "pending" })
    } else if (result?.type === "project") {
      const current = useGlobalSyncStore.getState()
      useGlobalSyncStore.setState({
        projects: applyGlobalProject(current, result.project).projects,
      })
    }
    return
  }

  childStores.mark(directory)

  // Notification dispatch for session turn-complete and error events.
  // These are NOT handled by the event reducer — only the notification store.
  if (payload.type === "session.idle" || payload.type === "session.error") {
    const props = payload.properties as { sessionID?: string; error?: { message?: string; code?: string } }
    const sessionID = props.sessionID
    // Skip subtask sessions — only top-level sessions generate notifications
    const storeState = store.getState()
    const session = storeState.session.find((s) => s.id === sessionID)
    if (session && (session as { parentID?: string }).parentID) {
      // subtask — skip notification
    } else if (sessionID) {
      appendNotification({
        directory,
        session: sessionID,
        time: Date.now(),
        viewed: isViewedInCurrentSession(directory, sessionID),
        ...(payload.type === "session.error"
          ? { type: "error" as const, error: props.error }
          : { type: "turn-complete" as const }),
      })
    }
  }

  // Read live state, create shallow draft, apply ONE event, write back.
  // Read live state, create shallow draft, apply ONE event, write back.
  const current = store.getState()
  const draft: State = {
    ...current,
    session: [...current.session],
    message: { ...current.message },
    part: { ...current.part },
    session_status: { ...current.session_status },
    session_diff: { ...current.session_diff },
    todo: { ...current.todo },
    permission: { ...current.permission },
    question: { ...current.question },
    mcp: { ...current.mcp },
    lsp: [...current.lsp],
  }

  if (applyDirectoryEvent(draft, payload)) {
    store.setState(draft)
  }

  // Update global session status for cross-directory sidebar visibility
  if (payload.type === "session.status") {
    const props = payload.properties as { sessionID: string; status: SessionStatus }
    setGlobalSessionStatus(props.sessionID, props.status)
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SyncProvider(props: {
  sdk: OpencodeClient
  directory: string
  children: React.ReactNode
}) {
  const childStoresRef = useRef<ChildStoreManager | null>(null)
  if (!childStoresRef.current) childStoresRef.current = new ChildStoreManager()
  const childStores = childStoresRef.current

  const system = useMemo<SyncSystem>(
    () => ({
      childStores,
      sdk: props.sdk,
      directory: props.directory,
    }),
    [childStores, props.sdk, props.directory],
  )

  // Configure child store manager
  useEffect(() => {
    const bootingDirs = new Set<string>()

    childStores.configure({
      onBootstrap: (directory) => {
        if (bootingDirs.has(directory)) return
        bootingDirs.add(directory)

        const store = childStores.getChild(directory)
        if (!store) return

        const globalState = useGlobalSyncStore.getState()
        bootstrapDirectory({
          directory,
          sdk: props.sdk,
          getState: () => store.getState(),
          set: (patch) => {
            store.setState(patch)
            // Sync session_status to global store for cross-directory visibility
            if (patch.session_status) {
              const current = useGlobalSessionStatusStore.getState().statuses
              const merged = { ...current, ...patch.session_status }
              useGlobalSessionStatusStore.setState({ statuses: merged })
            }
          },
          global: {
            config: globalState.config,
            projects: globalState.projects,
            providers: globalState.providers,
          },
          loadSessions: async (dir) => {
            const result = await props.sdk.session.list({
              directory: dir,
              roots: true,
              limit: 50,
            })
            const sessions = (result.data ?? [])
              .filter((s) => !!s?.id)
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            store.setState({ session: sessions, sessionTotal: sessions.length })
          },
        }).finally(() => {
          bootingDirs.delete(directory)
        })
      },
      onDispose: (directory) => {
        bootingDirs.delete(directory)
      },
      isBooting: (directory) => bootingDirs.has(directory),
      isLoadingSessions: () => false,
    })
  }, [childStores, props.sdk])

  // Bootstrap global state — set bootingRoot/bootedAt to suppress
  // redundant refresh events during startup
  useEffect(() => {
    bootingRoot = true
    const globalActions = useGlobalSyncStore.getState().actions
    bootstrapGlobal(props.sdk, globalActions.set)
      .then(() => {
        bootedAt = Date.now()
      })
      .finally(() => {
        bootingRoot = false
      })
  }, [props.sdk])

  // Event pipeline — created once per mount. No class, no start/stop.
  // Abort controller owned by the pipeline closure. Cleanup aborts + flushes.
  useEffect(() => {
    const { cleanup } = createEventPipeline({
      sdk: props.sdk,
      onEvent: (directory, payload) => {
        handleEvent(directory, payload, childStores)
      },
    })
    return cleanup
  }, [props.sdk, childStores])

  // Ensure current directory's child store exists
  useEffect(() => {
    if (props.directory) {
      childStores.ensureChild(props.directory)
    }
  }, [props.directory, childStores])

  // Set refs so non-React code (session-actions, session-ui-store) can access sync state
  useEffect(() => {
    setSyncRefs(props.sdk, childStores, props.directory)
    setActionRefs(
      props.sdk,
      () => childStores.ensureChild(props.directory),
      props.directory,
    )
  }, [props.sdk, props.directory, childStores])

  // Subscribe to child store for streaming state derivation
  useEffect(() => {
    if (!props.directory) return
    const store = childStores.getChild(props.directory)
    if (!store) return
    const unsubscribe = store.subscribe((state) => {
      updateStreamingState(state)
    })
    return unsubscribe
  }, [props.directory, childStores])

  return <SyncContext.Provider value={system}>{props.children}</SyncContext.Provider>
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Access the global sync store */
export function useGlobalSync() {
  return useGlobalSyncStore()
}

/** Access the global sync store with a selector */
export function useGlobalSyncSelector<T>(selector: (state: GlobalSyncStore) => T): T {
  return useGlobalSyncStore(selector)
}

/** Get the child store for a directory (defaults to current) */
export function useDirectoryStore(directory?: string): StoreApi<DirectoryStore> {
  const system = useSyncSystem()
  const dir = directory ?? system.directory
  return system.childStores.ensureChild(dir)
}

/** Select from the current directory's store */
export function useDirectorySync<T>(selector: (state: State) => T, directory?: string): T {
  const store = useDirectoryStore(directory)
  return useStore(store, selector)
}

/** Get the revert messageID for a session (if reverted) */
export function useSessionRevertMessageID(sessionID: string, directory?: string): string | undefined {
  return useDirectorySync(
    useCallback((state: State) => {
      const session = state.session.find((s) => s.id === sessionID)
      return (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID
    }, [sessionID]),
    directory,
  )
}

/** Get session messages for a specific session */
export function useSessionMessages(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.message[sessionID] ?? EMPTY_MESSAGES, [sessionID]),
    directory,
  )
}

/**
 * Get visible session messages — filters out reverted messages.
 * Filters out reverted messages (id >= session.revert.messageID).
 */
export function useVisibleSessionMessages(sessionID: string, directory?: string) {
  const messages = useSessionMessages(sessionID, directory)
  const revertMessageID = useSessionRevertMessageID(sessionID, directory)

  return useMemo(() => {
    if (!revertMessageID) return messages
    return messages.filter((m) => m.id < revertMessageID)
  }, [messages, revertMessageID])
}

/** Get parts for a specific message */
export function useSessionParts(messageID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.part[messageID] ?? EMPTY_PARTS, [messageID]),
    directory,
  )
}

/** Get status for a specific session */
export function useSessionStatus(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session_status[sessionID], [sessionID]),
    directory,
  )
}

/** Get permissions for a specific session */
export function useSessionPermissions(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.permission[sessionID] ?? EMPTY_PERMISSION_REQUESTS, [sessionID]),
    directory,
  )
}

/** Get questions for a specific session */
export function useSessionQuestions(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.question[sessionID] ?? EMPTY_QUESTION_REQUESTS, [sessionID]),
    directory,
  )
}

/** Get sessions list for a directory */
export function useSessions(directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session, []),
    directory,
  )
}

/** Get the SDK client */
export function useSyncSDK() {
  return useSyncSystem().sdk
}

/** Get the current directory */
export function useSyncDirectory() {
  return useSyncSystem().directory
}

/** Get the child store manager (for advanced operations) */
export function useChildStoreManager() {
  return useSyncSystem().childStores
}

/**
 * Get messages for a session in the old {info, parts}[] format.
 * Uses visible messages (filtered by revert state).
 * Uses visible messages (filtered by revert state).
 */
export function useSessionMessageRecords(sessionID: string, directory?: string) {
  const messages = useVisibleSessionMessages(sessionID, directory)

  const allParts = useDirectorySync(
    useCallback((state: State) => state.part, []),
    directory,
  )

  return useMemo(
    () => messages.map((msg) => ({
      info: msg,
      parts: allParts[msg.id] ?? EMPTY_PARTS,
    })),
    [messages, allParts],
  )
}

/**
 * Determines if a session is actively working.
 * Checks session_status AND incomplete assistant messages as fallback.
 * Returns false when permissions are pending (permission indicator takes priority).
 */
export function useIsSessionWorking(sessionID: string, directory?: string): boolean {
  const status = useSessionStatus(sessionID, directory)
  const permissions = useSessionPermissions(sessionID, directory)
  const messages = useSessionMessages(sessionID, directory)

  return useMemo(() => {
    // Permissions pending → not "working" (show permission indicator instead)
    if (permissions.length > 0) return false

    // Check session_status
    const statusWorking = status !== undefined && status.type !== "idle"

    // Check for incomplete assistant message (fallback if status event delayed)
    let hasPendingAssistant = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "assistant" && typeof (m as { time?: { completed?: number } }).time?.completed !== "number") {
        hasPendingAssistant = true
        break
      }
    }

    return statusWorking || hasPendingAssistant
  }, [status, permissions, messages])
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_PARTS: Part[] = []
const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []
const EMPTY_QUESTION_REQUESTS: QuestionRequest[] = []
