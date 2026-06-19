// src/cli/tui/gc-renderer/reconciler.ts
import createReconciler from 'react-reconciler'
import { ConcurrentRoot } from 'react-reconciler/constants.js'
import type { GCNode, GCContainer } from './types.js'
import { layoutTree, renderTree } from './layout.js'
import type { ScreenBuffer } from './screen.js'

function makeNode(type: string, props: Record<string, unknown>): GCNode {
  return {
    nodeType: type as GCNode['nodeType'],
    props: { ...props },
    children: [],
    parent: null,
    computedX: 0, computedY: 0, computedWidth: 0, computedHeight: 0,
    dirty: true,
  }
}

// We store the screen buffer separately since GCContainer is the reconciler container
const screenMap = new WeakMap<GCContainer, ScreenBuffer>()
export function setContainerScreen(c: GCContainer, s: ScreenBuffer): void { screenMap.set(c, s) }

type AnyObj = Record<string, unknown>

const reconciler = createReconciler<
  string, AnyObj, GCContainer, GCNode, GCNode,
  never, never, never, GCNode, object, null, ReturnType<typeof setTimeout>, -1, null
>({
  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1 as const,

  getRootHostContext: () => ({}),
  getChildHostContext: (ctx) => ctx,
  shouldSetTextContent: () => false,
  prepareForCommit: () => null,

  resetAfterCommit(container: GCContainer) {
    const screen = screenMap.get(container)
    if (!screen) return
    const { root, cols, rows } = container
    root.computedX = 0; root.computedY = 0
    root.computedWidth = cols; root.computedHeight = rows
    layoutTree(root, { x: 0, y: 0, availableWidth: cols, availableHeight: rows })
    renderTree(root, screen)
    screen.commit()
  },

  createInstance(type: string, props: AnyObj): GCNode { return makeNode(type, props) },
  createTextInstance(text: string): GCNode {
    const n = makeNode('gc-textnode', { text })
    n.textContent = text
    return n
  },

  appendInitialChild(parent: GCNode, child: GCNode): void {
    child.parent = parent; parent.children.push(child)
  },
  appendChild(parent: GCNode, child: GCNode): void {
    child.parent = parent; parent.children.push(child)
  },
  appendChildToContainer(container: GCContainer, child: GCNode): void {
    child.parent = container.root; container.root.children.push(child)
  },
  insertBefore(parent: GCNode, child: GCNode, before: GCNode): void {
    const idx = parent.children.indexOf(before)
    child.parent = parent
    idx >= 0 ? parent.children.splice(idx, 0, child) : parent.children.push(child)
  },
  insertInContainerBefore(container: GCContainer, child: GCNode, before: GCNode): void {
    const idx = container.root.children.indexOf(before)
    child.parent = container.root
    idx >= 0 ? container.root.children.splice(idx, 0, child) : container.root.children.push(child)
  },
  removeChild(parent: GCNode, child: GCNode): void {
    const idx = parent.children.indexOf(child)
    if (idx >= 0) parent.children.splice(idx, 1)
    child.parent = null
  },
  removeChildFromContainer(container: GCContainer, child: GCNode): void {
    const idx = container.root.children.indexOf(child)
    if (idx >= 0) container.root.children.splice(idx, 1)
    child.parent = null
  },

  finalizeInitialChildren: () => false,
  commitUpdate(instance: GCNode, _type: string, _prevProps: AnyObj, newProps: AnyObj): void {
    instance.props = { ...newProps }; instance.dirty = true
  },
  commitTextUpdate(instance: GCNode, _: string, newText: string): void {
    instance.textContent = newText; instance.props = { text: newText }; instance.dirty = true
  },
  getPublicInstance: (i: GCNode) => i,
  clearContainer: () => false,
  preparePortalMount: () => {},
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null as unknown as never,
  HostTransitionContext: { $$typeof: Symbol.for('react.context'), _currentValue: null } as never,
  setCurrentUpdatePriority: () => {},
  getCurrentUpdatePriority: () => 0,
  resolveUpdatePriority: () => 0,
  resetFormInstance: () => {},
  requestPostPaintCallback: () => {},
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1,
  detachDeletedInstance: () => {},
  getInstanceFromNode: () => null,
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  hideInstance: () => {},
  unhideInstance: () => {},
  hideTextInstance: () => {},
  unhideTextInstance: () => {},
  resetTextContent: () => {},
})

export { reconciler, ConcurrentRoot }
