"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { usePathname } from "next/navigation";

type GlobalLoadingContextValue = {
  isLoading: boolean;
  isLoadingScope: (scope: string) => boolean;
  setLoading: (scope: string, value: boolean) => void;
  runWithLoading: <T>(scope: string, task: () => Promise<T>) => Promise<T>;
  clearAll: () => void;
};

const GlobalLoadingContext = createContext<GlobalLoadingContextValue | null>(null);

export function GlobalLoadingProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [scopes, setScopes] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setScopes({});
  }, [pathname]);

  function setLoading(scope: string, value: boolean) {
    setScopes((current) => {
      if (value) {
        return { ...current, [scope]: true };
      }

      if (!current[scope]) {
        return current;
      }

      const next = { ...current };
      delete next[scope];
      return next;
    });
  }

  async function runWithLoading<T>(scope: string, task: () => Promise<T>) {
    setLoading(scope, true);

    try {
      return await task();
    } finally {
      setLoading(scope, false);
    }
  }

  function clearAll() {
    setScopes({});
  }

  function isLoadingScope(scope: string) {
    return Boolean(scopes[scope]);
  }

  return (
    <GlobalLoadingContext.Provider
      value={{
        isLoading: Object.keys(scopes).length > 0,
        isLoadingScope,
        setLoading,
        runWithLoading,
        clearAll,
      }}
    >
      {children}
    </GlobalLoadingContext.Provider>
  );
}

export function useGlobalLoading() {
  const context = useContext(GlobalLoadingContext);

  if (!context) {
    throw new Error("useGlobalLoading must be used inside GlobalLoadingProvider");
  }

  return context;
}
