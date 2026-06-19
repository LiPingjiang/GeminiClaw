import React, { createContext, useContext } from 'react'
export const FpsMetricsContext = createContext<any>(null)
export function useFpsMetrics(): any { return useContext(FpsMetricsContext) }
export default FpsMetricsContext
