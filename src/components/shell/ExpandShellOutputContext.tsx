import React, { createContext, useContext } from 'react'
export const ExpandShellOutputContext = createContext<any>(null)
export function useExpandShellOutput(): any { return useContext(ExpandShellOutputContext) }
export function ExpandShellOutputProvider({ children }: { children: React.ReactNode }): any {
  return React.createElement(ExpandShellOutputContext.Provider, { value: true }, children)
}
export default ExpandShellOutputContext
