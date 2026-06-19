import React, { createContext, useContext } from 'react'
export const StatsContext = createContext<any>(null)
export function useStats(): any { return useContext(StatsContext) }
export default StatsContext
