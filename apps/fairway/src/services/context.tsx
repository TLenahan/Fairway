import { AnalyticsEngine, AnalysisService, DataStore, MonitorService } from '@golf/types';
import { FairwayStore } from '@golf/store';
import { createContext, ReactNode, useContext } from 'react';
import { StoreApi } from 'zustand';
import { useStore } from 'zustand';

import { SettingsState } from './settings';

/**
 * Composition-root context. Everything is typed by the frozen contracts;
 * concrete implementations are assembled once in app-services.ts.
 */
export interface AppServices {
  monitor: MonitorService;
  data: DataStore;
  analytics: AnalyticsEngine;
  analysis: AnalysisService;
  store: FairwayStore;
  settings: StoreApi<SettingsState>;
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
