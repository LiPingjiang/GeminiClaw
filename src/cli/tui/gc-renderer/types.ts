// Core type definitions - no Yoga, no Ink
import type React from 'react'

export type GCNodeType =
  | 'gc-root'
  | 'gc-box'
  | 'gc-text'
  | 'gc-ansi'
  | 'gc-separator'
  | 'gc-textnode'

export interface GCNode {
  nodeType: GCNodeType
  props: Record<string, unknown>
  children: GCNode[]
  parent: GCNode | null
  textContent?: string

  // Computed by layout pass
  computedX: number
  computedY: number
  computedWidth: number
  computedHeight: number
  dirty: boolean
}

export interface GCContainer {
  root: GCNode
  cols: number
  rows: number
}

export interface LayoutConstraints {
  x: number
  y: number
  availableWidth: number
  availableHeight: number
}
