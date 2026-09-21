import React, { createContext, useContext, type ReactNode } from 'react';
import { usePipeline, type PipelineController } from './usePipeline';

const PipelineContext = createContext<PipelineController | null>(null);

/** No-op controller for renders outside the provider (isolated components,
 *  tests). The real one comes from PipelineProvider in the app shell. */
const INERT: PipelineController = {
  job: null,
  starting: false,
  running: false,
  error: null,
  start: async () => {},
  cancel: async () => {},
  refresh: async () => {},
};

/**
 * One pipeline controller for the whole app. The shell owns it so a run started
 * in the workspace stays visible (and cancellable) from any page via the global
 * run indicator, and there is exactly one poller.
 */
export function PipelineProvider({ children }: { children: ReactNode }) {
  const pipeline = usePipeline();
  return <PipelineContext.Provider value={pipeline}>{children}</PipelineContext.Provider>;
}

export function usePipelineContext(): PipelineController {
  return useContext(PipelineContext) ?? INERT;
}
