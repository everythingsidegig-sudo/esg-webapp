"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/database.types";

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  profileLoading: boolean;
  profileError: string | null;
  refreshProfile: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue>({ user: null, profile: null, loading: true,
  profileLoading: false, profileError: null, refreshProfile: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = createClient();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const activeUser = useRef<string | null>(null);
  const version = useRef(0);

  const loadProfile = useCallback(async (userId: string) => {
    const request = ++version.current;
    setProfileLoading(true);
    setProfileError(null);
    try {
      const { data, error } = await supabase.rpc("ensure_profile");
      if (error || !data || data.id !== userId) throw error ?? new Error("Missing profile");
      if (request === version.current && activeUser.current === userId) setProfile(data as Profile);
    } catch (error) {
      if (request === version.current && activeUser.current === userId) {
        setProfileError("We couldn't load your profile. Check your connection and retry.");
      }
      throw error;
    } finally {
      if (request === version.current) setProfileLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    let alive = true;
    const requestVersion = version;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    function applyUser(nextUser: User | null) {
      if (!alive) return;
      const changed = activeUser.current !== (nextUser?.id ?? null);
      activeUser.current = nextUser?.id ?? null;
      if (changed || !nextUser) {
        version.current++;
        setProfile(null);
        setProfileError(null);
      }
      setUser(nextUser);
      setLoading(false);
      if (nextUser) {
        setProfileLoading(true);
        // Defer queries until Supabase's auth callback releases its session lock.
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (alive && activeUser.current === nextUser.id) void loadProfile(nextUser.id).catch(() => {});
        }, 0);
        timers.add(timer);
      } else setProfileLoading(false);
    }
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => applyUser(session?.user ?? null));
    supabase.auth.getSession().then(({ error }) => {
      if (error && alive) { setLoading(false); setProfileError("Your session couldn't be restored. Please sign in again."); }
    }).catch(() => { if (alive) { setLoading(false); setProfileError("Your session couldn't be restored. Please sign in again."); } });
    return () => {
      alive = false; requestVersion.current++;
      timers.forEach(clearTimeout);
      listener.subscription.unsubscribe();
    };
  }, [supabase, loadProfile]);

  return <AuthContext.Provider value={{ user, profile, loading, profileLoading, profileError,
    refreshProfile: async () => { if (activeUser.current) await loadProfile(activeUser.current); },
  }}>{children}</AuthContext.Provider>;
}
export function useAuth() { return useContext(AuthContext); }
