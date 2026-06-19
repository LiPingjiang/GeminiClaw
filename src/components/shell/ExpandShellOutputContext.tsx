import React, { createContext, useContext } from 'react'
export const ExpandShellOutputContext = createContext<any>(null)
export function useExpandShellOutput(): any { return useContext(ExpandShellOutputContext) }
export default ExpandShellOutputContext