import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js'
import * as THREE from 'three/webgpu'
import { createGreatCircle, sampleEarthPath } from './earthMath'
import type { EarthColorScheme, EarthRenderSnapshot, EarthVisualMode } from './rendererTypes'
import type { EarthRoute } from './types'

const FLOW_DURATION_SECONDS = 0.85
const FLOW_STREAK_LENGTH = 0.14
const FLOW_STREAK_SEGMENTS = 14
const FLOW_COLOR = new THREE.Color('#ffffff')
const FLAT_LIGHT_FLOW_COLOR = new THREE.Color('#5ad9ef')
const LINE_ORIGIN_COLOR = new THREE.Color('#b8f7ff')
const LINE_DESTINATION_COLOR = new THREE.Color('#4f9dff')

interface RuntimeRoute {
  route: EarthRoute
  points: THREE.Vector3[]
  // 每方向的流光进度(数字字段,替代每帧按字符串 key 读写的 Map)
  uploadProgress: number
  downloadProgress: number
}

// 每条路由的大圆采样与线段顶点/颜色只依赖 path,按 key 缓存;
// 拓扑一变(新增/消失一条连接)不再把所有路由的 Quaternion 插值与顶点重算一遍
interface RouteGeometryCache {
  points: THREE.Vector3[]
  positions: number[]
  colors: number[]
}

const FLOW_DIRECTIONS = ['upload', 'download'] as const

interface RouteLayerOptions {
  earthGroup: THREE.Group
  visualMode: EarthVisualMode
  colorScheme: EarthColorScheme
}

export interface RouteLayer {
  setSnapshot: (snapshot: EarthRenderSnapshot, topologyChanged: boolean) => void
  setVisualMode: (mode: EarthVisualMode) => void
  setColorScheme: (scheme: EarthColorScheme) => void
  // 返回本帧是否仍有流光在动(用于按需渲染)
  update: (elapsed: number) => boolean
  dispose: () => void
}

export const createRouteLayer = (options: RouteLayerOptions): RouteLayer => {
  const { earthGroup } = options
  let lineGeometry = new LineSegmentsGeometry()
  const lineGlowMaterial = new THREE.Line2NodeMaterial({
    color: '#ffffff',
    linewidth: 5.5,
    transparent: true,
    opacity: 0.26,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const lineMaterial = new THREE.Line2NodeMaterial({
    color: '#ffffff',
    linewidth: 1.45,
    transparent: true,
    opacity: 0.96,
    vertexColors: true,
    depthWrite: false,
  })
  const lineGlow = new LineSegments2(lineGeometry, lineGlowMaterial)
  const lines = new LineSegments2(lineGeometry, lineMaterial)
  lineGlow.frustumCulled = false
  lines.frustumCulled = false
  // InstancedBufferGeometry defaults instanceCount to Infinity. Rendering the empty
  // placeholder before the first route snapshot makes WebGPU pass Infinity to
  // drawIndexed(), which is invalid. Only reveal it after finite segment data exists.
  lineGlow.visible = false
  lines.visible = false
  lineGlow.renderOrder = 1
  lines.renderOrder = 2
  earthGroup.add(lineGlow, lines)

  let flowGeometry = new LineSegmentsGeometry()
  const flowGlowMaterial = new THREE.Line2NodeMaterial({
    color: '#ffffff',
    linewidth: 9,
    transparent: true,
    opacity: 0.3,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const flowMaterial = new THREE.Line2NodeMaterial({
    color: '#ffffff',
    linewidth: 2.6,
    transparent: true,
    opacity: 0.96,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const flowGlow = new LineSegments2(flowGeometry, flowGlowMaterial)
  const flows = new LineSegments2(flowGeometry, flowMaterial)
  flowGlow.frustumCulled = false
  flows.frustumCulled = false
  flowGlow.visible = false
  flows.visible = false
  flowGlow.renderOrder = 3
  flows.renderOrder = 4
  earthGroup.add(flowGlow, flows)

  let runtimeRoutes: RuntimeRoute[] = []
  let routeGeometryCache = new Map<string, RouteGeometryCache>()
  let visualMode = options.visualMode
  let colorScheme = options.colorScheme
  let disposed = false
  let flowCapacity = 0
  let flowPositions = new Float32Array(0)
  let flowColors = new Float32Array(0)
  let flowPositionBuffer: THREE.InterleavedBuffer | null = null
  let flowColorBuffer: THREE.InterleavedBuffer | null = null
  const flowStart = new THREE.Vector3()
  const flowEnd = new THREE.Vector3()

  const applyVisualMode = () => {
    const flat = visualMode === 'flat'

    lineGlow.visible = !flat && lines.visible
    flowGlow.visible = !flat && flows.visible
    flowMaterial.blending = flat ? THREE.NormalBlending : THREE.AdditiveBlending
    flowMaterial.needsUpdate = true
  }

  const updateFlows = (delta: number, advance: boolean) => {
    if (disposed || flowPositions.length === 0) return false

    let flowSegmentIndex = 0
    const flowColor =
      visualMode === 'flat' && colorScheme === 'light' ? FLAT_LIGHT_FLOW_COLOR : FLOW_COLOR

    for (const runtime of runtimeRoutes) {
      for (const direction of FLOW_DIRECTIONS) {
        const rate = runtime.route[direction]

        if (rate <= 0) continue

        let progress = direction === 'upload' ? runtime.uploadProgress : runtime.downloadProgress

        if (advance) {
          progress = Math.min(
            1 + FLOW_STREAK_LENGTH,
            progress + (delta * (1 + FLOW_STREAK_LENGTH)) / FLOW_DURATION_SECONDS,
          )
          if (direction === 'upload') runtime.uploadProgress = progress
          else runtime.downloadProgress = progress
        }

        const trailStart = Math.max(0, progress - FLOW_STREAK_LENGTH)
        const trailEnd = Math.min(1, progress)
        const visibleLength = trailEnd - trailStart
        if (visibleLength <= 0) continue

        const segmentCount = Math.max(
          1,
          Math.ceil((visibleLength / FLOW_STREAK_LENGTH) * FLOW_STREAK_SEGMENTS),
        )
        for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
          const startRatio = segmentIndex / segmentCount
          const endRatio = (segmentIndex + 1) / segmentCount
          const startProgress = THREE.MathUtils.lerp(trailStart, trailEnd, startRatio)
          const endProgress = THREE.MathUtils.lerp(trailStart, trailEnd, endRatio)
          sampleEarthPath(
            runtime.points,
            direction === 'download' ? 1 - startProgress : startProgress,
            flowStart,
          )
          sampleEarthPath(
            runtime.points,
            direction === 'download' ? 1 - endProgress : endProgress,
            flowEnd,
          )

          const offset = flowSegmentIndex * 6
          flowPositions[offset] = flowStart.x
          flowPositions[offset + 1] = flowStart.y
          flowPositions[offset + 2] = flowStart.z
          flowPositions[offset + 3] = flowEnd.x
          flowPositions[offset + 4] = flowEnd.y
          flowPositions[offset + 5] = flowEnd.z
          flowColors[offset] = flowColor.r
          flowColors[offset + 1] = flowColor.g
          flowColors[offset + 2] = flowColor.b
          flowColors[offset + 3] = flowColor.r
          flowColors[offset + 4] = flowColor.g
          flowColors[offset + 5] = flowColor.b
          flowSegmentIndex += 1
        }
      }
    }

    flowGeometry.instanceCount = flowSegmentIndex
    flowGlow.visible = visualMode === 'space' && flowSegmentIndex > 0
    flows.visible = flowSegmentIndex > 0
    // 只上传实际写入的那段,而不是每帧整块容量缓冲
    const used = flowSegmentIndex * 6
    if (flowPositionBuffer) {
      flowPositionBuffer.clearUpdateRanges()
      if (used > 0) flowPositionBuffer.addUpdateRange(0, used)
      flowPositionBuffer.needsUpdate = true
    }
    if (flowColorBuffer) {
      flowColorBuffer.clearUpdateRanges()
      if (used > 0) flowColorBuffer.addUpdateRange(0, used)
      flowColorBuffer.needsUpdate = true
    }
    return flowSegmentIndex > 0
  }

  const buildRouteGeometry = (route: EarthRoute): RouteGeometryCache => {
    const points: THREE.Vector3[] = []
    const positions: number[] = []
    const colors: number[] = []

    for (let pathIndex = 0; pathIndex < route.path.length - 1; pathIndex += 1) {
      const from = route.path[pathIndex]
      const to = route.path[pathIndex + 1]
      const arc = createGreatCircle(from, to)

      points.push(...(points.length > 0 ? arc.slice(1) : arc))

      for (let pointIndex = 0; pointIndex < arc.length - 1; pointIndex += 1) {
        const start = arc[pointIndex]
        const end = arc[pointIndex + 1]
        const startProgress = pointIndex / (arc.length - 1)
        const endProgress = (pointIndex + 1) / (arc.length - 1)
        positions.push(start.x, start.y, start.z, end.x, end.y, end.z)
        colors.push(
          THREE.MathUtils.lerp(LINE_ORIGIN_COLOR.r, LINE_DESTINATION_COLOR.r, startProgress),
          THREE.MathUtils.lerp(LINE_ORIGIN_COLOR.g, LINE_DESTINATION_COLOR.g, startProgress),
          THREE.MathUtils.lerp(LINE_ORIGIN_COLOR.b, LINE_DESTINATION_COLOR.b, startProgress),
          THREE.MathUtils.lerp(LINE_ORIGIN_COLOR.r, LINE_DESTINATION_COLOR.r, endProgress),
          THREE.MathUtils.lerp(LINE_ORIGIN_COLOR.g, LINE_DESTINATION_COLOR.g, endProgress),
          THREE.MathUtils.lerp(LINE_ORIGIN_COLOR.b, LINE_DESTINATION_COLOR.b, endProgress),
        )
      }
    }

    return { points, positions, colors }
  }

  const rebuildGeometry = (routes: readonly EarthRoute[]) => {
    const previousRuntime = new Map(runtimeRoutes.map((runtime) => [runtime.route.key, runtime]))
    const nextCache = new Map<string, RouteGeometryCache>()
    let vertexCount = 0
    runtimeRoutes = []

    for (const route of routes) {
      const cached = routeGeometryCache.get(route.key) ?? buildRouteGeometry(route)
      const previous = previousRuntime.get(route.key)

      nextCache.set(route.key, cached)
      vertexCount += cached.positions.length
      runtimeRoutes.push({
        route,
        points: cached.points,
        uploadProgress: previous?.uploadProgress ?? 0,
        downloadProgress: previous?.downloadProgress ?? 0,
      })
    }
    routeGeometryCache = nextCache

    const positions = new Float32Array(vertexCount)
    const colors = new Float32Array(vertexCount)
    let offset = 0

    for (const runtime of runtimeRoutes) {
      const cached = routeGeometryCache.get(runtime.route.key)!
      positions.set(cached.positions, offset)
      colors.set(cached.colors, offset)
      offset += cached.positions.length
    }

    const previousGeometry = lineGeometry
    lineGeometry = new LineSegmentsGeometry()

    if (positions.length > 0) {
      lineGeometry.setPositions(positions)
      lineGeometry.setColors(colors)
      lineGlow.visible = visualMode === 'space'
      lines.visible = true
    } else {
      lineGlow.visible = false
      lines.visible = false
    }

    lineGlow.geometry = lineGeometry
    lines.geometry = lineGeometry
    previousGeometry.dispose()

    // 流光缓冲按容量复用,只在路由数超出时才翻倍重建
    const neededFlowCapacity = Math.max(1, runtimeRoutes.length * 2 * FLOW_STREAK_SEGMENTS)

    if (neededFlowCapacity > flowCapacity) {
      const previousFlowGeometry = flowGeometry
      flowCapacity = Math.max(neededFlowCapacity, flowCapacity * 2, 64 * FLOW_STREAK_SEGMENTS)
      flowPositions = new Float32Array(flowCapacity * 6)
      flowColors = new Float32Array(flowCapacity * 6)
      flowGeometry = new LineSegmentsGeometry()
      flowGeometry.setPositions(flowPositions)
      flowGeometry.setColors(flowColors)
      flowPositionBuffer = (
        flowGeometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute
      ).data
      flowColorBuffer = (
        flowGeometry.getAttribute('instanceColorStart') as THREE.InterleavedBufferAttribute
      ).data
      flowPositionBuffer.setUsage(THREE.DynamicDrawUsage)
      flowColorBuffer.setUsage(THREE.DynamicDrawUsage)
      flowGeometry.instanceCount = 0
      flowGlow.geometry = flowGeometry
      flows.geometry = flowGeometry
      previousFlowGeometry.dispose()
    }
  }

  applyVisualMode()

  return {
    setSnapshot(snapshot, topologyChanged) {
      if (disposed) return

      if (topologyChanged) {
        rebuildGeometry(snapshot.routes)
      } else {
        const nextByKey = new Map(snapshot.routes.map((route) => [route.key, route]))

        for (const runtime of runtimeRoutes) {
          const next = nextByKey.get(runtime.route.key)
          if (next) runtime.route = next
        }
      }

      // 每拍新快照到达,流光从起点重新出发(与原实现一致)
      for (const runtime of runtimeRoutes) {
        runtime.uploadProgress = 0
        runtime.downloadProgress = 0
      }
      updateFlows(0, false)
    },
    setVisualMode(mode) {
      if (disposed || visualMode === mode) return
      visualMode = mode
      applyVisualMode()
      updateFlows(0, false)
    },
    setColorScheme(scheme) {
      if (disposed || colorScheme === scheme) return
      colorScheme = scheme
      updateFlows(0, false)
    },
    update(elapsed) {
      return updateFlows(elapsed, true)
    },
    dispose() {
      if (disposed) return
      disposed = true
      earthGroup.remove(lineGlow, lines, flowGlow, flows)
      lineGeometry.dispose()
      lineGlowMaterial.dispose()
      lineMaterial.dispose()
      flowGeometry.dispose()
      flowGlowMaterial.dispose()
      flowMaterial.dispose()
      runtimeRoutes = []
      routeGeometryCache.clear()
    },
  }
}
