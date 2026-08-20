import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import * as THREE from 'three/webgpu'
import { createCityLabelLayer } from './cityLabelLayer'
import { getRealtimeSunDirection, toEarthVector } from './earthMath'
import { createEndpointLayer } from './endpointLayer'
import { createGlobeLayer } from './globeLayer'
import { createEarthRenderSnapshot } from './renderSnapshot'
import type { EarthRenderer as EarthRendererContract, EarthRendererOptions } from './rendererTypes'
import { createRouteLayer } from './routeLayer'

export type { EarthRenderer } from './rendererTypes'

const MAX_INITIAL_LATITUDE = 15

type Cleanup = () => void

const runCleanups = (cleanups: Cleanup[]) => {
  let firstError: unknown

  while (cleanups.length > 0) {
    try {
      cleanups.pop()!()
    } catch (error) {
      firstError ??= error
    }
  }

  if (firstError) throw firstError
}

export const createEarthRenderer = async (
  container: HTMLElement,
  options: EarthRendererOptions,
): Promise<EarthRendererContract> => {
  const cleanups: Cleanup[] = []
  let disposed = false
  const registerCleanup = (cleanup: Cleanup) => cleanups.push(cleanup)
  const disposeResources = () => {
    if (disposed) return
    disposed = true
    runCleanups(cleanups)
  }

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100)
  camera.position.set(3.7, 1.55, 3.2)

  const renderer = new THREE.WebGPURenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.domElement.className = 'h-full w-full cursor-grab active:cursor-grabbing'
  renderer.domElement.style.display = 'block'

  try {
    container.appendChild(renderer.domElement)
    registerCleanup(() => {
      renderer.setAnimationLoop(null)
      try {
        renderer.dispose()
      } finally {
        renderer.domElement.remove()
      }
    })
    await renderer.init()

    const labelRenderer = new CSS2DRenderer()
    labelRenderer.sortObjects = false
    labelRenderer.domElement.className = 'pointer-events-none absolute inset-0 overflow-hidden'
    labelRenderer.domElement.setAttribute('aria-hidden', 'true')
    container.appendChild(labelRenderer.domElement)
    registerCleanup(() => labelRenderer.domElement.remove())

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.enablePan = false
    controls.minDistance = 2.65
    controls.maxDistance = 7.5
    controls.rotateSpeed = 0.55
    controls.zoomSpeed = 0.75
    controls.touches.ONE = THREE.TOUCH.ROTATE
    controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE
    // Keep browser scrolling/navigation gestures inside the canvas from competing
    // with OrbitControls on touch devices.
    renderer.domElement.style.touchAction = 'none'
    registerCleanup(() => controls.dispose())

    const earthGroup = new THREE.Group()
    scene.add(earthGroup)
    registerCleanup(() => scene.remove(earthGroup))

    let reducedMotion = options.reducedMotion
    let visualMode = options.visualMode
    let colorScheme = options.colorScheme
    let autoRotation = true
    let initialLocationSet = false
    let visible = !document.hidden
    let intersecting = true
    let pinnedEndpoint = false
    let currentSignature = ''
    const clock = new THREE.Clock()
    const sunDirection = getRealtimeSunDirection()

    const globeLayer = await createGlobeLayer({
      scene,
      earthGroup,
      renderer,
      visualMode,
      colorScheme,
      sunDirection,
    })
    registerCleanup(() => globeLayer.dispose())

    const routeLayer = createRouteLayer({ earthGroup, visualMode, colorScheme })
    registerCleanup(() => routeLayer.dispose())

    const endpointLayer = createEndpointLayer({
      earthGroup,
      camera,
      visualMode,
      sunDirection,
    })
    registerCleanup(() => endpointLayer.dispose())

    const cityLabelLayer = createCityLabelLayer({
      earthGroup,
      camera,
      controls,
      labelRenderer,
    })
    registerCleanup(() => cityLabelLayer.dispose())

    const updateSunForTime = () => {
      getRealtimeSunDirection(new Date(), sunDirection)
      globeLayer.setSunDirection(sunDirection)
      endpointLayer.setSunDirection(sunDirection)
    }

    // 按需渲染:画面没有任何变化的帧(自转暂停、扁平模式无脉冲、无流光、相机静止、
    // 无新数据)不再每帧 render + CSS2D 全量遍历;有变化才画
    let renderRequested = true

    const render = () => {
      if (!disposed && visible && intersecting) {
        renderRequested = false
        cityLabelLayer.updateVisibility()
        renderer.render(scene, camera)
        labelRenderer.render(scene, camera)
      }
    }
    const requestRender = () => {
      renderRequested = true
      if (reducedMotion) render()
    }

    const animate = () => {
      if (disposed) return

      // 长停顿(GC、大表重排、后台标签页恢复的第一帧)后 clock.getDelta() 可能是 0.3~2s。
      // 所有随时间推进的状态必须吃同一个钳制值,否则彼此脱节:此前流光吃的是未钳制的原始
      // 值,一帧就被推到轨迹终点并钳死 → 整批流光凭空消失。这里干脆不再保留未钳制的绑定,
      // 让「谁该用哪个 delta」不再有第二个选项
      const delta = Math.min(0.05, clock.getDelta())
      if (autoRotation) earthGroup.rotation.y += delta * 0.025
      endpointLayer.update(delta)
      if (visualMode === 'space') globeLayer.syncSunLight()
      const cameraMoved = controls.update(delta)
      const flowsActive = routeLayer.update(delta)

      if (
        renderRequested ||
        autoRotation ||
        cameraMoved ||
        flowsActive ||
        // 太空模式的端点光晕在脉冲、日照随时间移动
        visualMode === 'space'
      ) {
        render()
      }
    }

    const updateAnimationLoop = () => {
      if (disposed) return

      renderer.setAnimationLoop(null)
      clock.stop()

      if (!visible || !intersecting) return

      updateSunForTime()

      renderRequested = true
      if (reducedMotion) {
        controls.enableDamping = false
        render()
      } else {
        controls.enableDamping = true
        clock.start()
        renderer.setAnimationLoop(animate)
      }
    }

    const showEndpoint = (event: PointerEvent, pin = false) => {
      const bounds = renderer.domElement.getBoundingClientRect()
      const endpoint = endpointLayer.hitTest(event.clientX, event.clientY, bounds)

      if (endpoint) {
        pinnedEndpoint = pin
        options.onEndpointHover(endpoint, event.clientX, event.clientY)
        renderer.domElement.style.cursor = 'pointer'
      } else if (!pinnedEndpoint || pin) {
        pinnedEndpoint = false
        options.onEndpointHover(null)
        renderer.domElement.style.cursor = ''
      }
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!pinnedEndpoint && event.pointerType !== 'touch') showEndpoint(event)
    }
    const onClick = (event: PointerEvent) => showEndpoint(event, true)
    const onPointerLeave = () => {
      if (!pinnedEndpoint) options.onEndpointHover(null)
    }
    renderer.domElement.addEventListener('pointermove', onPointerMove)
    renderer.domElement.addEventListener('click', onClick)
    renderer.domElement.addEventListener('pointerleave', onPointerLeave)
    registerCleanup(() => {
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('click', onClick)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
    })

    const resizeObserver = new ResizeObserver(([entry]) => {
      const width = Math.max(1, entry.contentRect.width)
      const height = Math.max(1, entry.contentRect.height)

      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
      labelRenderer.setSize(width, height)
      render()
    })
    resizeObserver.observe(container)
    registerCleanup(() => resizeObserver.disconnect())

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        intersecting = entry.isIntersecting
        updateAnimationLoop()
      },
      { threshold: 0.01 },
    )
    intersectionObserver.observe(container)
    registerCleanup(() => intersectionObserver.disconnect())

    const onVisibilityChange = () => {
      visible = !document.hidden
      updateAnimationLoop()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    registerCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange))

    // sunDirection 无条件保持新鲜(不再只在 space 模式下刷新)。之前只有太空模式才刷新,
    // 于是「flat 待了一小时再切到 space」时晨昏线停在一小时前的经度 —— 而 setVisualMode 里
    // 补一行只能堵住这一个切换点。让不变量变成「任何时刻 sunDirection 都不超过 60 秒陈旧」,
    // 调用者不必再记得在模式切换处补刷;代价是 flat 下每分钟一次纯计算(flat 材质不读它)
    const sunTimer = window.setInterval(() => {
      updateSunForTime()
      requestRender()
    }, 60_000)
    registerCleanup(() => window.clearInterval(sunTimer))

    const onControlsChange = () => {
      requestRender()
    }
    controls.addEventListener('change', onControlsChange)
    registerCleanup(() => controls.removeEventListener('change', onControlsChange))

    updateAnimationLoop()

    return {
      setRoutes(incomingRoutes) {
        if (disposed) return

        const snapshot = createEarthRenderSnapshot(incomingRoutes)
        const topologyChanged = snapshot.signature !== currentSignature
        currentSignature = snapshot.signature
        routeLayer.setSnapshot(snapshot, topologyChanged)
        const endpoints = endpointLayer.setSnapshot(snapshot, topologyChanged)
        cityLabelLayer.setEndpoints(endpoints)
        requestRender()
      },
      setInitialLocation(location) {
        if (
          disposed ||
          initialLocationSet ||
          !Number.isFinite(location.latitude) ||
          !Number.isFinite(location.longitude)
        ) {
          return
        }

        initialLocationSet = true
        const distance = camera.position.distanceTo(controls.target)
        const direction = toEarthVector({
          latitude: THREE.MathUtils.clamp(
            location.latitude,
            -MAX_INITIAL_LATITUDE,
            MAX_INITIAL_LATITUDE,
          ),
          longitude: location.longitude,
        })
          .applyQuaternion(earthGroup.quaternion)
          .normalize()
        camera.position.copy(controls.target).addScaledVector(direction, distance)
        controls.update()
        requestRender()
      },
      setReducedMotion(value) {
        if (disposed) return
        reducedMotion = value
        updateAnimationLoop()
      },
      setAutoRotation(enabled) {
        if (disposed) return
        autoRotation = enabled
        requestRender()
      },
      setCityLabelsVisible(nextVisible) {
        if (disposed) return
        cityLabelLayer.setVisible(nextVisible)
        // CSS2DRenderer 会在下一帧把不可见分组的标签置为 display:none,需要再画一帧
        requestRender()
      },
      setVisualMode(mode) {
        if (disposed || visualMode === mode) return
        visualMode = mode
        globeLayer.setVisualMode(mode)
        routeLayer.setVisualMode(mode)
        endpointLayer.setVisualMode(mode)
        requestRender()
      },
      setColorScheme(scheme) {
        if (disposed || colorScheme === scheme) return
        colorScheme = scheme
        globeLayer.setColorScheme(scheme)
        routeLayer.setColorScheme(scheme)
        requestRender()
      },
      dispose: disposeResources,
    }
  } catch (error) {
    try {
      disposeResources()
    } catch {
      // Preserve the initialization error while still attempting every cleanup.
    }
    throw error
  }
}
