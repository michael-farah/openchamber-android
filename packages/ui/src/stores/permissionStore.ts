import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import type { Session } from "@opencode-ai/sdk/v2/client";
import {
    type PermissionAutoAcceptMap,
} from "./utils/permissionAutoAccept";
import { getSafeStorage } from "./utils/safeStorage";
import { getSyncSessions } from "@/sync/sync-refs";

interface PermissionState {
    autoAccept: PermissionAutoAcceptMap;
}

interface PermissionActions {
    isSessionAutoAccepting: (sessionId: string) => boolean;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
}

type PermissionStore = PermissionState & PermissionActions;

const resolveLineage = (sessionID: string, sessions: Session[]): string[] => {
    const map = new Map<string, Session>();
    for (const session of sessions) {
        map.set(session.id, session);
    }

    const result: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = sessionID;
    while (current && !seen.has(current)) {
        seen.add(current);
        result.push(current);
        current = map.get(current)?.parentID;
    }
    return result;
};

const autoRespondsPermissionBySession = (
    autoAccept: PermissionAutoAcceptMap,
    sessions: Session[],
    sessionID: string,
): boolean => {
    for (const id of resolveLineage(sessionID, sessions)) {
        if (id in autoAccept) {
            return autoAccept[id] === true;
        }
    }
    return false;
};

const getStorage = () => createJSONStorage(() => getSafeStorage());

export const usePermissionStore = create<PermissionStore>()(
    devtools(
        persist(
            (set, get) => ({
                autoAccept: {},

                isSessionAutoAccepting: (sessionId: string) => {
                    if (!sessionId) {
                        return false;
                    }

                    const sessions = getSyncSessions();
                    return autoRespondsPermissionBySession(get().autoAccept, sessions, sessionId);
                },

                setSessionAutoAccept: async (sessionId: string, enabled: boolean) => {
                    if (!sessionId) {
                        return;
                    }

                    set((state) => ({
                        autoAccept: {
                            ...state.autoAccept,
                            [sessionId]: enabled,
                        },
                    }));
                },
            }),
            {
                name: "permission-store",
                storage: getStorage(),
                partialize: (state) => ({ autoAccept: state.autoAccept }),
                merge: (persistedState, currentState) => {
                    const merged = {
                        ...currentState,
                        ...(persistedState as Partial<PermissionStore>),
                    };

                    const nextAutoAccept = Object.fromEntries(
                        Object.entries(merged.autoAccept || {}).map(([sessionId, enabled]) => [
                            sessionId,
                            Boolean(enabled),
                        ]),
                    );

                    return {
                        ...merged,
                        autoAccept: nextAutoAccept,
                    };
                },
            }
        ),
        { name: "permission-store" }
    )
);
