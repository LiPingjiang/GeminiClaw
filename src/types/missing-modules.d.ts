// Type declarations for packages without bundled types
declare module 'bidi-js' {
  interface BidiInstance {
    getEmbeddingLevels(text: string, baseDirection?: 'ltr' | 'rtl' | 'auto'): {
      levels: Uint8Array
      paragraphs: Array<{ start: number; end: number; level: number }>
    }
    getReorderSegments(text: string, levels: Uint8Array, paragraphs: unknown): Array<[number, number]>
    getVisualIndex(logicalIndex: number, levels: Uint8Array): number
  }
  function bidiFactory(): BidiInstance
  export default bidiFactory
}

declare module 'lodash-es/noop.js' {
  const noop: (...args: unknown[]) => undefined
  export default noop
}

declare module 'lodash-es/throttle.js' {
  function throttle<T extends (...args: unknown[]) => unknown>(
    func: T,
    wait?: number,
    options?: { leading?: boolean; trailing?: boolean },
  ): T & { cancel(): void; flush(): void }
  export default throttle
}
