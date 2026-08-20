import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DObject, type CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import * as THREE from 'three/webgpu'
import type { EarthRenderEndpoint } from './rendererTypes'

const CITY_LABEL_CLASS_NAME =
  'pointer-events-none whitespace-nowrap rounded-md bg-base-100/80 px-1.5 py-1 text-[10px] font-semibold leading-none text-base-content shadow-sm backdrop-blur-sm'
const CITY_LABEL_COLLISION_GAP = 4
const CITY_LABEL_MIN_BUDGET = 3
const CITY_LABEL_MAX_BUDGET = 64
const CITY_LABEL_AREA_PER_ITEM = 5_500
const CITY_LABEL_FALLBACK_HEIGHT = 18

interface ProjectedCityLabel {
  endpoint: EarthRenderEndpoint
  label: CSS2DObject
  left: number
  right: number
  top: number
  bottom: number
}

interface CityLabelLayerOptions {
  earthGroup: THREE.Group
  camera: THREE.Camera
  controls: OrbitControls
  labelRenderer: CSS2DRenderer
}

export interface CityLabelLayer {
  setEndpoints: (endpoints: readonly EarthRenderEndpoint[]) => void
  setVisible: (visible: boolean) => void
  updateVisibility: () => void
  dispose: () => void
}

export const createCityLabelLayer = (options: CityLabelLayerOptions): CityLabelLayer => {
  const { camera, controls, earthGroup, labelRenderer } = options
  const labelGroup = new THREE.Group()
  earthGroup.add(labelGroup)

  const labels = new Map<string, CSS2DObject>()
  // 标签尺寸只随文本变化,而文本只在 syncLabels 里写 —— 失效就放在那唯一的写点上,
  // 读侧因此不必每帧重新 trim 城市名再比一次字符串。measured 记的是「这条尺寸是真量到的
  // 还是估算的」:CSS2DRenderer 给不可见标签写 display:none,那时 gBCR 恒为 0×0
  const labelSizes = new Map<CSS2DObject, { width: number; height: number; measured: boolean }>()
  let endpoints: readonly EarthRenderEndpoint[] = []
  let disposed = false
  const cameraWorldPosition = new THREE.Vector3()
  const earthWorldPosition = new THREE.Vector3()
  const labelWorldPosition = new THREE.Vector3()
  const labelSurfaceNormal = new THREE.Vector3()
  const labelToCamera = new THREE.Vector3()
  const projectedLabelPosition = new THREE.Vector3()

  const fallbackLabelWidth = (text: string) =>
    12 +
    Array.from(text).reduce(
      (width, character) => width + (character.codePointAt(0)! > 0xff ? 10 : 6),
      0,
    )

  const labelsOverlap = (left: ProjectedCityLabel, right: ProjectedCityLabel) =>
    left.left < right.right + CITY_LABEL_COLLISION_GAP &&
    left.right + CITY_LABEL_COLLISION_GAP > right.left &&
    left.top < right.bottom + CITY_LABEL_COLLISION_GAP &&
    left.bottom + CITY_LABEL_COLLISION_GAP > right.top

  const syncLabels = () => {
    const visibleKeys = new Set<string>()

    for (const endpoint of endpoints) {
      const city = endpoint.city.trim()

      if (!city) continue

      visibleKeys.add(endpoint.key)
      let label = labels.get(endpoint.key)

      if (!label) {
        const element = document.createElement('div')
        element.className = CITY_LABEL_CLASS_NAME
        label = new CSS2DObject(element)
        label.center.set(0.5, 1.5)
        label.renderOrder = 7
        labels.set(endpoint.key, label)
        labelGroup.add(label)
      }

      if (label.element.textContent !== city) {
        label.element.textContent = city
        labelSizes.delete(label)
      }
      label.position.copy(endpoint.position)
    }

    for (const [key, label] of labels) {
      if (visibleKeys.has(key)) continue
      labelGroup.remove(label)
      labels.delete(key)
      labelSizes.delete(label)
    }
  }

  const measureLabel = (label: CSS2DObject) => {
    const cached = labelSizes.get(label)
    // 只读内联 style 属性和 isConnected,都不触发布局。上一帧被预算/碰撞挡下的标签这时
    // 是 display:none,量到的只会是 0×0 —— 旧代码因此拒绝缓存,于是这批标签每帧都要
    // getBoundingClientRect,其中第一个还会在 labelRenderer 上一帧刚写完 transform/display
    // 之后强制一次全文档样式重算 + 布局。把「这次量不到」也记下来,稳态下 gBCR 归零;
    // 标签一旦真被显示,下一帧就用真实宽度覆盖估算值
    const displayed = label.element.isConnected && label.element.style.display !== 'none'

    if (cached && (cached.measured || !displayed)) return cached

    const bounds = displayed ? label.element.getBoundingClientRect() : null
    const size = {
      width: bounds?.width || fallbackLabelWidth(label.element.textContent ?? ''),
      height: bounds?.height || CITY_LABEL_FALLBACK_HEIGHT,
      measured: (bounds?.width ?? 0) > 0,
    }

    labelSizes.set(label, size)
    return size
  }

  // CSS labels do not share the globe's depth buffer. First discard cities past
  // the tangent horizon, then choose a zoom-dependent number of high-priority
  // labels whose screen-space rectangles do not overlap.
  const updateVisibility = () => {
    if (disposed || !labelGroup.visible) return

    // 一次性更新地球子树与相机的世界矩阵;各标签直接读 matrixWorld,
    // 不再对每个标签调 getWorldPosition 反复回溯父链
    camera.updateWorldMatrix(true, false)
    earthGroup.updateWorldMatrix(true, true)
    cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld)
    earthWorldPosition.setFromMatrixPosition(earthGroup.matrixWorld)

    const { width, height } = labelRenderer.getSize()
    const candidates: ProjectedCityLabel[] = []

    for (const endpoint of endpoints) {
      const label = labels.get(endpoint.key)

      if (!label) continue
      label.visible = false
      labelWorldPosition.setFromMatrixPosition(label.matrixWorld)
      labelSurfaceNormal.subVectors(labelWorldPosition, earthWorldPosition).normalize()
      labelToCamera.subVectors(cameraWorldPosition, labelWorldPosition)

      if (labelSurfaceNormal.dot(labelToCamera) <= 0) continue

      projectedLabelPosition.copy(labelWorldPosition).project(camera)
      if (
        projectedLabelPosition.z < -1 ||
        projectedLabelPosition.z > 1 ||
        projectedLabelPosition.x < -1 ||
        projectedLabelPosition.x > 1 ||
        projectedLabelPosition.y < -1 ||
        projectedLabelPosition.y > 1
      ) {
        continue
      }

      const x = (projectedLabelPosition.x * 0.5 + 0.5) * width
      const y = (-projectedLabelPosition.y * 0.5 + 0.5) * height
      const { width: labelWidth, height: labelHeight } = measureLabel(label)

      candidates.push({
        endpoint,
        label,
        left: x - labelWidth * label.center.x,
        right: x + labelWidth * (1 - label.center.x),
        top: y - labelHeight * label.center.y,
        bottom: y + labelHeight * (1 - label.center.y),
      })
    }

    // endpoints 已在 setEndpoints 时按优先级排好序,candidates 天然有序,无需每帧再排

    const cameraDistance = camera.position.distanceTo(controls.target)
    const zoom =
      1 -
      THREE.MathUtils.clamp(
        (cameraDistance - controls.minDistance) / (controls.maxDistance - controls.minDistance),
        0,
        1,
      )
    const viewportBudget = THREE.MathUtils.clamp(
      Math.floor((width * height) / CITY_LABEL_AREA_PER_ITEM),
      CITY_LABEL_MIN_BUDGET,
      CITY_LABEL_MAX_BUDGET,
    )
    const labelBudget = Math.round(
      THREE.MathUtils.lerp(CITY_LABEL_MIN_BUDGET, viewportBudget, zoom * zoom),
    )
    const accepted: ProjectedCityLabel[] = []

    for (const candidate of candidates) {
      if (accepted.length >= labelBudget) break
      if (accepted.some((visibleLabel) => labelsOverlap(candidate, visibleLabel))) continue

      candidate.label.visible = true
      accepted.push(candidate)
    }
  }

  return {
    setEndpoints(nextEndpoints) {
      if (disposed) return
      // 优先级(本机 > 连接数多 > key)每秒排一次即可,不必每帧在候选集上重排
      endpoints = [...nextEndpoints].sort(
        (left, right) =>
          Number(right.role === 'origin') - Number(left.role === 'origin') ||
          right.connections - left.connections ||
          (left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
      )
      syncLabels()
    },
    setVisible(visible) {
      if (disposed) return
      labelGroup.visible = visible
    },
    updateVisibility,
    dispose() {
      if (disposed) return
      disposed = true
      earthGroup.remove(labelGroup)
      labelGroup.clear()
      labels.clear()
      labelSizes.clear()
      endpoints = []
    },
  }
}
