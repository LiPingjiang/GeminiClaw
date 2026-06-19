import React, { createContext, useContext } from 'react'
export const QueuedMessageContext = createContext<any>(null)
export function useQueuedMessage(): any { return useContext(QueuedMessageContext) }
export function QueuedMessageProvider(..._args: any[]): any { return null }
export default QueuedMessageContext
