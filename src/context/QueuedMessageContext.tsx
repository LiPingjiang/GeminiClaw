import React, { createContext, useContext } from 'react'
export const QueuedMessageContext = createContext<any>(null)
export function useQueuedMessage(): any { return useContext(QueuedMessageContext) }
export default QueuedMessageContext
