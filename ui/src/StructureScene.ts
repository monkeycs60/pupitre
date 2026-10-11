import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { StructureLayout, StructureNode, StructureRect } from './structureMap'

export interface StructureSceneLabel {
  id: string
  text: string
  touched: number
  isNew: boolean
}

export interface StructureSceneCallbacks {
  onHover: (node: StructureNode | null, x: number, y: number) => void
  onSelect: (node: StructureNode | null) => void
}

export interface StructurePalette {
  background: string
  ground: string
  platform: string
  platformTouched: string
  untouched: string
  added: string
  modified: string
  deleted: string
  renamed: string
  highlight: string
}

const LEVEL_STEP = 0.16
const GROW_MS = 900
const MAX_LABELS = 26

function buildingHeight(node: StructureNode): number {
  if (node.kind === 'block') return 0.05
  if (node.touched === 0) return 0.14
  return 0.9 + Math.log2(1 + node.churn) * 0.62
}

function statusColor(node: StructureNode, palette: StructurePalette): string {
  switch (node.file?.status) {
    case 'A': return palette.added
    case 'D': return palette.deleted
    case 'R': return palette.renamed
    case 'M': return palette.modified
    default: return palette.untouched
  }
}

export class StructureScene {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000)
  private readonly controls: OrbitControls
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly resizeObserver: ResizeObserver
  private readonly labelLayer: HTMLDivElement
  private readonly labels: Array<{ element: HTMLDivElement, position: THREE.Vector3, width: number, height: number }> = []
  private readonly disposables: Array<{ dispose: () => void }> = []
  private touchedMesh: THREE.InstancedMesh | null = null
  private untouchedMesh: THREE.InstancedMesh | null = null
  private capMesh: THREE.InstancedMesh | null = null
  private touchedRects: StructureRect[] = []
  private untouchedRects: StructureRect[] = []
  private readonly rectById = new Map<string, StructureRect>()
  private readonly baseColors = new Map<string, THREE.Color>()
  private highlighted = new Set<string>()
  private hoveredId: string | null = null
  private frame = 0
  private startedAt = 0
  private size = 40
  private flight: { from: THREE.Vector3, to: THREE.Vector3, targetFrom: THREE.Vector3, targetTo: THREE.Vector3, startedAt: number } | null = null
  private pointerDown: { x: number, y: number } | null = null
  private readonly reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  private readonly container: HTMLElement
  private readonly callbacks: StructureSceneCallbacks
  private readonly palette: StructurePalette

  constructor(container: HTMLElement, palette: StructurePalette, callbacks: StructureSceneCallbacks) {
    this.container = container
    this.palette = palette
    this.callbacks = callbacks
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.className = 'structure-canvas'
    container.appendChild(this.renderer.domElement)

    this.labelLayer = document.createElement('div')
    this.labelLayer.className = 'structure-labels'
    container.appendChild(this.labelLayer)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.09
    this.controls.maxPolarAngle = Math.PI / 2.15
    this.controls.screenSpacePanning = false

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x20222a, 1.15))

    const canvas = this.renderer.domElement
    canvas.addEventListener('pointermove', this.handlePointerMove)
    canvas.addEventListener('pointerleave', this.handlePointerLeave)
    canvas.addEventListener('pointerdown', this.handlePointerDown)
    canvas.addEventListener('pointerup', this.handlePointerUp)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.frame = requestAnimationFrame(this.tick)
  }

  setLayout(layout: StructureLayout): void {
    this.clearContent()
    this.size = layout.size
    const palette = this.palette
    this.scene.fog = new THREE.Fog(palette.background, layout.size * 1.6, layout.size * 4.2)

    const sun = new THREE.DirectionalLight(0xffffff, 1.9)
    sun.position.set(layout.size * 0.55, layout.size * 0.95, layout.size * 0.35)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    const reach = layout.size * 0.8
    Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 1, far: layout.size * 3 })
    sun.shadow.bias = -0.0006
    this.addContent(sun)

    const ground = new THREE.Mesh(
      this.track(new THREE.CircleGeometry(layout.size * 1.5, 64)),
      this.track(new THREE.MeshStandardMaterial({ color: palette.ground, roughness: 1 })),
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.02
    ground.receiveShadow = true
    this.addContent(ground)

    const box = this.track(new THREE.BoxGeometry(1, 1, 1))
    const matrix = new THREE.Matrix4()
    const color = new THREE.Color()

    const platformMaterial = this.track(new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }))
    const platforms = new THREE.InstancedMesh(box, platformMaterial, layout.platforms.length)
    platforms.receiveShadow = true
    layout.platforms.forEach((rect, index) => {
      const top = rect.level * LEVEL_STEP
      matrix.compose(
        new THREE.Vector3(rect.x + rect.width / 2, top - LEVEL_STEP / 2, rect.z + rect.depth / 2),
        new THREE.Quaternion(),
        new THREE.Vector3(rect.width, LEVEL_STEP, rect.depth),
      )
      platforms.setMatrixAt(index, matrix)
      color.set(rect.node.touched > 0 ? palette.platformTouched : palette.platform)
      color.offsetHSL(0, 0, (rect.level % 2 === 0 ? 0.012 : -0.012) + Math.min(rect.level, 6) * 0.012)
      platforms.setColorAt(index, color)
      this.rectById.set(rect.node.id, rect)
    })
    if (platforms.instanceColor) platforms.instanceColor.needsUpdate = true
    this.addContent(platforms)

    for (const rect of layout.platforms.filter((item) => item.node.isNew)) {
      const outline = new THREE.LineSegments(
        this.track(new THREE.EdgesGeometry(new THREE.BoxGeometry(rect.width, 0.02, rect.depth))),
        this.track(new THREE.LineBasicMaterial({ color: palette.added })),
      )
      outline.position.set(rect.x + rect.width / 2, rect.level * LEVEL_STEP + 0.02, rect.z + rect.depth / 2)
      this.addContent(outline)
    }

    this.touchedRects = layout.buildings.filter((rect) => rect.node.touched > 0)
    this.untouchedRects = layout.buildings.filter((rect) => rect.node.touched === 0)
    for (const rect of layout.buildings) this.rectById.set(rect.node.id, rect)

    const untouchedMaterial = this.track(new THREE.MeshStandardMaterial({ roughness: 0.9, transparent: true, opacity: 0.55 }))
    this.untouchedMesh = new THREE.InstancedMesh(box, untouchedMaterial, this.untouchedRects.length)
    this.untouchedMesh.receiveShadow = true
    this.untouchedRects.forEach((rect, index) => {
      const height = buildingHeight(rect.node)
      matrix.compose(
        new THREE.Vector3(rect.x + rect.width / 2, rect.level * LEVEL_STEP + height / 2, rect.z + rect.depth / 2),
        new THREE.Quaternion(),
        new THREE.Vector3(rect.width, height, rect.depth),
      )
      this.untouchedMesh!.setMatrixAt(index, matrix)
      color.set(palette.untouched)
      if (rect.node.kind === 'block') color.offsetHSL(0, 0, -0.04)
      this.untouchedMesh!.setColorAt(index, color)
    })
    if (this.untouchedMesh.instanceColor) this.untouchedMesh.instanceColor.needsUpdate = true
    this.addContent(this.untouchedMesh)

    const touchedMaterial = this.track(new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.08 }))
    this.touchedMesh = new THREE.InstancedMesh(box, touchedMaterial, this.touchedRects.length)
    this.touchedMesh.castShadow = true
    this.touchedMesh.receiveShadow = true
    this.touchedRects.forEach((rect) => this.baseColors.set(rect.node.id, new THREE.Color(statusColor(rect.node, palette))))
    this.addContent(this.touchedMesh)

    const uncommitted = this.touchedRects.filter((rect) => rect.node.file?.uncommitted)
    const capMaterial = this.track(new THREE.MeshBasicMaterial({ color: palette.highlight, transparent: true, opacity: 0.9 }))
    this.capMesh = new THREE.InstancedMesh(box, capMaterial, uncommitted.length)
    this.capMesh.userData.rects = uncommitted
    this.addContent(this.capMesh)

    this.buildLabels(layout)
    this.startedAt = performance.now()
    this.applyGrowth(this.reducedMotion ? 1 : 0)
    this.paint()
    this.resetCamera(false)
  }

  setHighlight(ids: Iterable<string>): void {
    this.highlighted = new Set(ids)
    this.paint()
  }

  focus(nodeId: string): boolean {
    const rect = this.rectById.get(nodeId)
    if (!rect) return false
    const span = Math.max(rect.width, rect.depth, this.size * 0.16)
    const target = new THREE.Vector3(rect.x + rect.width / 2, rect.level * LEVEL_STEP, rect.z + rect.depth / 2)
    const offset = new THREE.Vector3(span * 1.1, span * 1.9, span * 2)
    this.fly(target.clone().add(offset), target)
    return true
  }

  resetCamera(animated = true): void {
    const target = new THREE.Vector3(0, 0, 0)
    const position = new THREE.Vector3(this.size * 0.6, this.size * 1.02, this.size * 1.08)
    if (animated && !this.reducedMotion) this.fly(position, target)
    else {
      this.camera.position.copy(position)
      this.controls.target.copy(target)
      this.controls.update()
    }
    this.controls.minDistance = 3
    this.controls.maxDistance = this.size * 2.6
  }

  dispose(): void {
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointermove', this.handlePointerMove)
    canvas.removeEventListener('pointerleave', this.handlePointerLeave)
    canvas.removeEventListener('pointerdown', this.handlePointerDown)
    canvas.removeEventListener('pointerup', this.handlePointerUp)
    this.clearContent()
    this.controls.dispose()
    this.renderer.dispose()
    canvas.remove()
    this.labelLayer.remove()
  }

  private track<T extends { dispose: () => void }>(resource: T): T {
    this.disposables.push(resource)
    return resource
  }

  private addContent(object: THREE.Object3D): void {
    object.userData.content = true
    this.scene.add(object)
  }

  private clearContent(): void {
    for (const object of this.scene.children.filter((child) => child.userData.content)) this.scene.remove(object)
    for (const resource of this.disposables.splice(0)) resource.dispose()
    this.labels.splice(0)
    this.labelLayer.replaceChildren()
    this.rectById.clear()
    this.baseColors.clear()
    this.touchedMesh = null
    this.untouchedMesh = null
    this.capMesh = null
    this.hoveredId = null
  }

  private buildLabels(layout: StructureLayout): void {
    const candidates = layout.platforms
      .filter((rect) => rect.node.touched > 0)
      .sort((left, right) => left.level - right.level || right.node.touched - left.node.touched)
      .slice(0, MAX_LABELS)
    for (const rect of candidates) {
      const element = document.createElement('div')
      element.className = `structure-label${rect.node.isNew ? ' is-new' : ''}${rect.level === 0 ? ' is-root' : ''}`
      element.textContent = rect.node.name
      this.labelLayer.appendChild(element)
      this.labels.push({
        element,
        position: new THREE.Vector3(
          rect.x + rect.width / 2,
          rect.level * LEVEL_STEP + 0.05,
          rect.level === 0 ? rect.z + 0.25 : rect.z + rect.depth / 2,
        ),
        width: element.offsetWidth,
        height: element.offsetHeight,
      })
    }
  }

  private applyGrowth(progress: number): void {
    if (!this.touchedMesh) return
    const matrix = new THREE.Matrix4()
    const quaternion = new THREE.Quaternion()
    const count = Math.max(1, this.touchedRects.length)
    this.touchedRects.forEach((rect, index) => {
      const delay = (index / count) * 0.45
      const local = Math.min(1, Math.max(0, (progress - delay) / (1 - 0.45)))
      const eased = 1 - Math.pow(1 - local, 3)
      const height = Math.max(0.02, buildingHeight(rect.node) * eased)
      matrix.compose(
        new THREE.Vector3(rect.x + rect.width / 2, rect.level * LEVEL_STEP + height / 2, rect.z + rect.depth / 2),
        quaternion,
        new THREE.Vector3(rect.width, height, rect.depth),
      )
      this.touchedMesh!.setMatrixAt(index, matrix)
    })
    this.touchedMesh.instanceMatrix.needsUpdate = true
    this.touchedMesh.computeBoundingSphere()

    if (this.capMesh) {
      const rects = this.capMesh.userData.rects as StructureRect[]
      rects.forEach((rect, index) => {
        const height = buildingHeight(rect.node) * (progress >= 1 ? 1 : 1 - Math.pow(1 - progress, 3))
        matrix.compose(
          new THREE.Vector3(rect.x + rect.width / 2, rect.level * LEVEL_STEP + height + 0.04, rect.z + rect.depth / 2),
          quaternion,
          new THREE.Vector3(rect.width * 1.04, 0.07, rect.depth * 1.04),
        )
        this.capMesh!.setMatrixAt(index, matrix)
      })
      this.capMesh.instanceMatrix.needsUpdate = true
    }
  }

  private paint(): void {
    if (!this.touchedMesh) return
    const dimmed = this.highlighted.size > 0
    const color = new THREE.Color()
    const background = new THREE.Color(this.palette.platform)
    this.touchedRects.forEach((rect, index) => {
      color.copy(this.baseColors.get(rect.node.id)!)
      if (dimmed && !this.highlighted.has(rect.node.id)) color.lerp(background, 0.78)
      if (rect.node.id === this.hoveredId) color.lerp(new THREE.Color(this.palette.highlight), 0.4)
      this.touchedMesh!.setColorAt(index, color)
    })
    if (this.touchedMesh.instanceColor) this.touchedMesh.instanceColor.needsUpdate = true
  }

  private fly(position: THREE.Vector3, target: THREE.Vector3): void {
    if (this.reducedMotion) {
      this.camera.position.copy(position)
      this.controls.target.copy(target)
      return
    }
    this.flight = {
      from: this.camera.position.clone(),
      to: position,
      targetFrom: this.controls.target.clone(),
      targetTo: target,
      startedAt: performance.now(),
    }
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth)
    const height = Math.max(1, this.container.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  private pick(event: PointerEvent): StructureNode | null {
    const bounds = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const meshes = [this.touchedMesh, this.untouchedMesh].filter((mesh): mesh is THREE.InstancedMesh => mesh !== null && mesh.count > 0)
    const hit = this.raycaster.intersectObjects(meshes, false)[0]
    if (!hit || hit.instanceId === undefined) return null
    const rects = hit.object === this.touchedMesh ? this.touchedRects : this.untouchedRects
    return rects[hit.instanceId]?.node ?? null
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const node = this.pick(event)
    const id = node?.id ?? null
    if (id !== this.hoveredId) {
      this.hoveredId = id
      this.paint()
      this.renderer.domElement.style.cursor = node?.kind === 'file' ? 'pointer' : ''
    }
    const bounds = this.container.getBoundingClientRect()
    this.callbacks.onHover(node, event.clientX - bounds.left, event.clientY - bounds.top)
  }

  private readonly handlePointerLeave = (): void => {
    this.hoveredId = null
    this.paint()
    this.callbacks.onHover(null, 0, 0)
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.pointerDown = { x: event.clientX, y: event.clientY }
    this.flight = null
  }

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const start = this.pointerDown
    this.pointerDown = null
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return
    this.callbacks.onSelect(this.pick(event))
  }

  private readonly tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick)
    if (this.startedAt > 0 && !this.reducedMotion) {
      const progress = Math.min(1, (now - this.startedAt) / GROW_MS)
      this.applyGrowth(progress)
      if (progress >= 1) this.startedAt = 0
    }
    if (this.flight) {
      const progress = Math.min(1, (now - this.flight.startedAt) / 650)
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2
      this.camera.position.lerpVectors(this.flight.from, this.flight.to, eased)
      this.controls.target.lerpVectors(this.flight.targetFrom, this.flight.targetTo, eased)
      if (progress >= 1) this.flight = null
    }
    if (this.capMesh) (this.capMesh.material as THREE.MeshBasicMaterial).opacity = this.reducedMotion ? 0.9 : 0.55 + Math.sin(now / 320) * 0.35
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.positionLabels()
  }

  private positionLabels(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    const projected = new THREE.Vector3()
    const placed: Array<{ left: number, top: number, right: number, bottom: number }> = []
    for (const label of this.labels) {
      projected.copy(label.position).project(this.camera)
      const x = ((projected.x + 1) / 2) * width
      const y = ((1 - projected.y) / 2) * height
      const box = { left: x - label.width / 2 - 3, top: y - label.height / 2 - 2, right: x + label.width / 2 + 3, bottom: y + label.height / 2 + 2 }
      const visible = projected.z < 1 && box.left > 0 && box.right < width && box.top > 0 && box.bottom < height
      const collides = placed.some((other) => box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom)
      if (!visible || collides) {
        label.element.style.opacity = '0'
        continue
      }
      placed.push(box)
      label.element.style.opacity = '1'
      label.element.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`
    }
  }
}
