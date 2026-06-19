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

declare module 'figures' {
  const figures: Record<string, string>
  export default figures
  export const tick: string
  export const cross: string
  export const arrowRight: string
  export const pointer: string
  export const bullet: string
  export const line: string
  export const ellipsis: string
  export const info: string
  export const warning: string
  export const checkboxOn: string
  export const checkboxOff: string
  export const checkboxCircleOn: string
  export const checkboxCircleOff: string
}

declare module 'asciichart' {
  export function plot(series: number[], options?: Record<string, unknown>): string
  export const lightblue: string
  export const blue: string
  export const green: string
  export const red: string
  export const reset: string
}

declare module 'fuse.js' {
  interface FuseOptions<T> {
    keys?: Array<string | { name: string; weight: number }>
    threshold?: number
    includeScore?: boolean
    includeMatches?: boolean
    [key: string]: unknown
  }
  interface FuseResult<T> {
    item: T
    score?: number
    matches?: unknown[]
  }
  class Fuse<T> {
    constructor(list: T[], options?: FuseOptions<T>)
    search(pattern: string): FuseResult<T>[]
  }
  export default Fuse
}

declare module 'axios' {
  interface AxiosResponse<T = any> { data: T; status: number; headers: any }
  interface AxiosInstance {
    post<T = any>(url: string, data?: any, config?: any): Promise<AxiosResponse<T>>
    get<T = any>(url: string, config?: any): Promise<AxiosResponse<T>>
  }
  const axios: AxiosInstance & { create(config?: any): AxiosInstance }
  export default axios
}

declare module 'qrcode' {
  export function toString(text: string, options?: Record<string, unknown>): Promise<string>
  export function toDataURL(text: string, options?: Record<string, unknown>): Promise<string>
}

declare module 'bun:bundle' {
  export function feature(name: string): boolean
}
