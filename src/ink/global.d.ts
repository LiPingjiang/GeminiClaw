// Custom JSX intrinsic elements used by the Ink renderer
declare namespace JSX {
  interface IntrinsicElements {
    'ink-box': Record<string, unknown>
    'ink-text': Record<string, unknown>
    'ink-link': Record<string, unknown>
    'ink-raw-ansi': Record<string, unknown>
    'ink-virtual-text': Record<string, unknown>
  }
}
