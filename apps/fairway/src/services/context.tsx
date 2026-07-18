import type { summarizeClub, summarizeSession } from '@golf/analytics';
import {
  AnalysisService,
  DataStore,
  MonitorService,
  WristService,
} from '@golf/types';
import { FairwayStore } from '@golf/store';
import { createContext, ReactNode, useContext } from 'react';
import { StoreApi } from 'zustand';
import { useStore } from 'zustand';

import { SettingsState } from './settings';
import { WristCaptureRecorder } from './wrist-capture';

/**
 * Composition-root context. Everything is typed by the frozen contracts;
 * concrete implementations are assembled once in app-services.ts.
 */
export interface AppServices {
  monitor: MonitorService;
  wrist: WristService;
  data: DataStore;
  /** concrete engine — the extra optional params (clubs, baselines) matter here */
  analytics: {
    summarizeSession: typeof summarizeSession;
    summarizeClub: typeof summarizeClub;
  };
  analysis: AnalysisService;
  store: FairwayStore;
  settings: StoreApi<SettingsState>;
  /** raw wrist-frame recorder — ground truth for tuning swing detection */
  wristCapture: WristCaptureRecorder;
}

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  services: AppServices;
  children: ReactNode;
}) {
  return (
    <ServicesContext.Provider value={services}>
      {children}
    </ServicesContext.Provider>
  );
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) {
    throw new Error('useServices must be used inside ServicesProvider');
  }
  return services;
}

export function useFairwayStore<T>(
  selector: (state: ReturnType<FairwayStore['getState']>) => T,
): T {
  const { store } = useServices();
  return useStore(store, selector);
}

export function useSettings<T>(selector: (state: SettingsState) => T): T {
  const { settings } = useServices();
  return useStore(settings, selector);
}
