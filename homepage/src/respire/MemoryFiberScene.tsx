import {SCULPTURE_URL} from '../destinations';
"use client";

import { useEffect, useId, useRef, useState } from 'react';
import styles from './MemoryFiberScene.module.css';
import { createMemoryFiberLines, createMemoryRedThread } from './memory-fiber-lines';
import { memoryFiberVertexShader, memoryFiberFragmentShader, memoryGroundVertexShader, memoryGroundFragmentShader } from './memory-fiber-shader';
import { createMemorySurfaceData } from './memory-fiber-surface';

export interface MemoryFiberSceneProps { className?: string; locale?: 'en' | 'zh' }

const clamp = (n: number, low = 0, high = 1) => Math.max(low, Math.min(high, n));
const smooth = (a: number, b: number, value: number) => {
  const x = clamp((value - a) / (b - a));
  return x * x * (3 - 2 * x);
};

/** A vector field, not an edited image: gray is neutral and RG encode local offsets.
 * The ring mask protects the cavity, silhouette edges, background, and floor shadow.
 * Two complementary fields let different fiber folds inhale at different phases.
 */
function displacementField(phase: number, pointer = false): string | null {
  const canvas = document.createElement('canvas');
  const size = pointer ? 96 : 192;
  canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const pixels = context.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = (x / (size - 1) - .5) * 2;
    const ny = (y / (size - 1) - (pointer ? .5 : .52)) * 2;
    const radius = Math.hypot(nx, ny / .96);
    const angle = Math.atan2(ny, nx);
    const ring = smooth(.23, .40, radius) * (1 - smooth(.79, 1.015, radius));
    const mask = pointer ? 1 - smooth(.08, .95, radius) : ring;
    const lobe = .48 + .52 * Math.cos(angle * 2 + phase) ** 2;
    const radial = mask * (pointer ? .35 * smooth(0,.10,radius) : .42 * lobe);
    const tangent = pointer ? 0 : mask * .075 * Math.sin(angle * 3 + phase);
    const dx = Math.cos(angle) * radial - Math.sin(angle) * tangent;
    const dy = Math.sin(angle) * radial + Math.cos(angle) * tangent;
    const index = (y * size + x) * 4;
    pixels.data[index] = Math.round(clamp(.5 + dx * .45) * 255);
    pixels.data[index + 1] = Math.round(clamp(.5 + dy * .45) * 255);
    pixels.data[index + 2] = 128;
    pixels.data[index + 3] = pointer ? Math.round(mask * 255) : 255;
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Matching reference points: exterior left loop on wide layouts, lower trough
 * beside the stacked mobile actions. Both are on the supplied red strand. */
function fallbackAnchorPoint():[number,number] {
  return window.innerWidth<=767?[610,755]:[75.76,556.62];
}

/** Inverse SVG displacement keeps the narrative attached to the fallback thread. */
function fallbackFieldAt(x:number,y:number,phase:number,pointer=false) {
  const nx=(x-.5)*2,ny=(y-(pointer?.5:.52))*2;
  const radius=Math.hypot(nx,ny/.96),angle=Math.atan2(ny,nx);
  const ring=smooth(.23,.40,radius)*(1-smooth(.79,1.015,radius));
  const mask=pointer?1-smooth(.08,.95,radius):ring;
  const lobe=.48+.52*Math.cos(angle*2+phase)**2;
  const radial=mask*(pointer?.35*smooth(0,.10,radius):.42*lobe),tangent=pointer?0:mask*.075*Math.sin(angle*3+phase);
  const alpha=pointer?mask:1;
  return [(Math.cos(angle)*radial-Math.sin(angle)*tangent)*.45*alpha,(Math.sin(angle)*radial+Math.cos(angle)*tangent)*.45*alpha];
}
function inverseFallbackField(point:number[],scale:number,phase:number,pointer?:{x:number;y:number}) {
  let q=[...point];
  for(let i=0;i<6;i++){
    const x=pointer?(q[0]-(pointer.x*1000-170))/340:q[0]/1000;
    const y=pointer?(q[1]-(pointer.y*1000-170))/340:q[1]/1000;
    const f=pointer&&(x<0||x>1||y<0||y>1)?[0,0]:fallbackFieldAt(x,y,phase,!!pointer);
    q=[point[0]-scale*f[0],point[1]-scale*f[1]];
  }
  return q;
}

/** Reference-traced layered sheet Geometry and a user-source-inspired ShaderMaterial,
 * with a faithful, localized-deformation image fallback when WebGL is unavailable.
 */
export default function MemoryFiberScene({ className = '', locale = 'en' }: MemoryFiberSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const gpuHostRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<SVGCircleElement>(null);
  const gpuReadyRef = useRef(false);
  const gpuWakeRef = useRef<(() => void) | null>(null);
  const [gpuReady, setGpuReady] = useState(false);
  const fieldARef = useRef<SVGFEImageElement>(null);
  const fieldBRef = useRef<SVGFEImageElement>(null);
  const pointerFieldRef = useRef<SVGFEImageElement>(null);
  const foldARef = useRef<SVGFEDisplacementMapElement>(null);
  const foldBRef = useRef<SVGFEDisplacementMapElement>(null);
  const pointerFoldRef = useRef<SVGFEDisplacementMapElement>(null);
  const wakeRef = useRef<(() => void) | null>(null);
  const motion = useRef({ paused: false, reduced: false, x: .5, y: .5, targetX: .5, targetY: .5, strength: 0, targetStrength: 0 });
  const [paused, setPaused] = useState(false);
  const filterId = `memory-fibers-${useId().replace(/:/g, '')}`;
  const zh = locale === 'zh';

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let visible = true;
    let frame = 0;
    let previous = 0;
    let rendered = 0;
    let elapsed = 0;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const mobile = window.matchMedia('(max-width: 640px)').matches;
    const interval = 1000 / (mobile ? 24 : 30);
    const fieldA = displacementField(.25);
    const fieldB = displacementField(1.72);
    const pointerField = displacementField(0, true);
    if (fieldA) fieldARef.current?.setAttribute('href', fieldA);
    if (fieldB) fieldBRef.current?.setAttribute('href', fieldB);
    if (pointerField) pointerFieldRef.current?.setAttribute('href', pointerField);
    const supported = !!(fieldA && fieldB && pointerField);
    const syncFallbackAnchor=(scaleA:number,scaleB:number,pointerScale:number)=>{
      let anchor=inverseFallbackField(fallbackAnchorPoint(),scaleA,.25);
      anchor=inverseFallbackField(anchor,scaleB,1.72);
      anchor=inverseFallbackField(anchor,pointerScale,0,motion.current);
      anchorRef.current?.setAttribute('cx',anchor[0].toFixed(2));
      anchorRef.current?.setAttribute('cy',anchor[1].toFixed(2));
      host.dispatchEvent(new CustomEvent('memory-thread-anchor',{bubbles:true}));
    };
    const staticFrame = () => {
      foldARef.current?.setAttribute('scale', '0');
      foldBRef.current?.setAttribute('scale', '0');
      pointerFoldRef.current?.setAttribute('scale', '0');
      if(!gpuReadyRef.current)syncFallbackAnchor(0,0,0);
    };
    const canRun = () => supported && !gpuReadyRef.current && !disposed && visible && !document.hidden && !motion.current.paused && !motion.current.reduced;
    const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
    const request = () => { if (!frame && canRun()) frame = requestAnimationFrame(draw); };
    function draw(now: number) {
      frame = 0;
      if (!canRun()) { previous = 0; return; }
      const delta = previous ? Math.min((now - previous) / 1000, .06) : 0;
      previous = now;
      elapsed += delta;
      if (now - rendered >= interval) {
        rendered = now;
        const phase = elapsed * Math.PI * 2 / 12;
        // Different folds relax at different phases; the entire image stays fixed.
        const scaleA=62*Math.sin(phase),scaleB=44*(Math.sin(phase+1.35)-Math.sin(1.35));
        foldARef.current?.setAttribute('scale', scaleA.toFixed(3));
        foldBRef.current?.setAttribute('scale', scaleB.toFixed(3));
        const m = motion.current;
        m.x += (m.targetX - m.x) * .12;
        m.y += (m.targetY - m.y) * .12;
        m.strength += (m.targetStrength - m.strength) * .075;
        pointerFieldRef.current?.setAttribute('x', String(m.x * 1000 - 170));
        pointerFieldRef.current?.setAttribute('y', String(m.y * 1000 - 170));
        pointerFoldRef.current?.setAttribute('scale', (m.strength * 10).toFixed(3));
        syncFallbackAnchor(scaleA,scaleB,m.strength*10);
      }
      request();
    }
    const preferenceChange = () => {
      motion.current.reduced = media.matches;
      host.dataset.reducedMotion = String(media.matches);
      if (media.matches || !supported) { stop(); staticFrame(); } else request();
      gpuWakeRef.current?.();
    };
    const visibilityChange = () => { if (document.hidden) stop(); else request(); };
    const viewportChange = () => {
      if(gpuReadyRef.current)return;
      if(motion.current.reduced||!supported)staticFrame();
      else if(motion.current.paused)syncFallbackAnchor(Number(foldARef.current?.getAttribute('scale')||0),Number(foldBRef.current?.getAttribute('scale')||0),Number(pointerFoldRef.current?.getAttribute('scale')||0));
      else request();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      host.dataset.motionVisible = String(visible);
      if (visible) request(); else stop();
    }, { threshold: .02 });
    observer.observe(host);
    media.addEventListener('change', preferenceChange);
    document.addEventListener('visibilitychange', visibilityChange);
    window.addEventListener('resize', viewportChange);
    wakeRef.current = () => { if (motion.current.paused) stop(); else request(); };
    if(!gpuReadyRef.current)syncFallbackAnchor(0,0,0);
    preferenceChange();
    return () => {
      disposed = true; stop(); observer.disconnect();
      media.removeEventListener('change', preferenceChange);
      document.removeEventListener('visibilitychange', visibilityChange);
      window.removeEventListener('resize', viewportChange);
      wakeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const host = gpuHostRef.current;
    if (!host) return;
    let disposed = false;
    let release = () => {};
    void import('three').then(async (THREE) => {
      if (disposed) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }); }
      catch { host.dataset.gpuStatus = 'unavailable'; return; }
      const mobile = window.matchMedia('(max-width: 640px)').matches;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.75));
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.domElement.setAttribute('aria-hidden', 'true');
      host.appendChild(renderer.domElement);
      host.dataset.gpuStatus = 'loading';
      release = () => { renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); };
      const reference = await new THREE.TextureLoader().loadAsync(SCULPTURE_URL);
      if (disposed) { reference.dispose(); return; }
      reference.colorSpace = THREE.SRGBColorSpace;
      reference.anisotropy = Math.min(8,renderer.capabilities.getMaxAnisotropy());
      const releaseRenderer = release;
      release = () => { reference.dispose(); releaseRenderer(); };
      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-2.508, 2.508, 2.508, -2.508, .1, 30);
      camera.position.set(0, 0, 8);
      camera.lookAt(0, 0, 0);
      // Every vertex is a parameter on one independently draped sheet. The same
      // calibrated reference contours drive both support and individual fibers.
      const surfaceData = createMemorySurfaceData(mobile);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(surfaceData.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(surfaceData.normals, 3));
      geometry.setAttribute('surfaceParam', new THREE.BufferAttribute(surfaceData.params, 3));
      geometry.setAttribute('calibratedColor', new THREE.BufferAttribute(surfaceData.colors, 3));
      geometry.setIndex(new THREE.BufferAttribute(surfaceData.indices, 1));
      const uniforms = {
        uReference: { value: reference },
        uTime: { value: 0 }, uEpsilon: { value: mobile ? .00075 : .00045 },
        uRayOrigin: { value: new THREE.Vector3() },
        uLightDirection: { value: new THREE.Vector3() },
        uPointer: { value: new THREE.Vector3() },
        uBoneColor: { value: new THREE.Color('#68685f') },
        uThreadColor: { value: new THREE.Color('#a93021') },
        uObjectToClip: { value: new THREE.Matrix4() },
        uObjectToWorld: { value: new THREE.Matrix4() },
      };
      const material = new THREE.ShaderMaterial({
        uniforms, vertexShader: memoryFiberVertexShader, fragmentShader: memoryFiberFragmentShader,
        side: THREE.DoubleSide, depthWrite: true, transparent: true, forceSinglePass: true,
        name: 'Respire reference-traced draped sheet material',
      });
      const body = new THREE.Mesh(geometry, material);
      body.frustumCulled = false;
      const fibers = createMemoryFiberLines(THREE, uniforms, mobile);
      const redThread = createMemoryRedThread(THREE);
      body.add(fibers.object, redThread.object);
      scene.add(body);
      const groundGeometry = new THREE.PlaneGeometry(5.016, 5.016);
      const groundMaterial = new THREE.ShaderMaterial({
        vertexShader: memoryGroundVertexShader, fragmentShader: memoryGroundFragmentShader,
        transparent: true, depthWrite: false,
      });
      const ground = new THREE.Mesh(groundGeometry, groundMaterial);
      ground.position.z = -1; ground.renderOrder = -1;
      scene.add(ground);
      const inverseModel = new THREE.Matrix4();
      const worldLight = new THREE.Vector3(-.6, .85, 1).normalize();
      const synchronizeCamera = () => {
        body.updateMatrixWorld(true);
        camera.updateMatrixWorld(true);
        inverseModel.copy(body.matrixWorld).invert();
        uniforms.uRayOrigin.value.copy(camera.position).applyMatrix4(inverseModel);
        uniforms.uLightDirection.value.copy(worldLight).transformDirection(inverseModel);
        uniforms.uObjectToWorld.value.copy(body.matrixWorld);
        uniforms.uObjectToClip.value.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse).multiply(body.matrixWorld);
      };
      // The connector follows the actual separate vermilion curve, not the
      // raster fallback or a now-obsolete strand ID in the demonstration shader.
      const anchorPoint = new THREE.Vector3();
      let anchorAngle: number | null = null, anchorNarrow: boolean | null = null, anchorX = NaN, anchorY = NaN;
      const projectRedStrand = (angle: number) => anchorPoint.copy(redThread.pointAt(angle)).applyMatrix4(body.matrixWorld).project(camera);
      const updateAnchor = () => {
        const narrow=window.innerWidth<=767;
        if(anchorNarrow!==narrow){anchorNarrow=narrow;anchorAngle=null;}
        if (anchorAngle === null) {
          let best = Infinity;
          for (let i = 0; i < 256; i++) {
            const angle = i / 256 * Math.PI * 2;
            // Select a visible point in sculpture space, independently of
            // camera aspect: left exterior on desktop, lower trough on mobile.
            const point=redThread.pointAt(angle);
            if (point.z < .15) continue;
            const score = (point.x/2.508-(narrow?.22:-.85))**2+(point.y/2.508-(narrow?-.51:-.115))**2;
            if (score < best) { best = score; anchorAngle = angle; }
          }
        }
        const point = projectRedStrand(anchorAngle ?? 1.1);
        const aspect = host.clientWidth / Math.max(1, host.clientHeight);
        const x = 500 + point.x * 500 * Math.max(aspect, 1);
        const y = 500 - point.y * 500 / Math.min(aspect, 1);
        if (Math.abs(x - anchorX) > .02 || Math.abs(y - anchorY) > .02 || !Number.isFinite(anchorX)) {
          anchorX = x; anchorY = y;
          anchorRef.current?.setAttribute('cx', x.toFixed(2));
          anchorRef.current?.setAttribute('cy', y.toFixed(2));
          host.dispatchEvent(new CustomEvent('memory-thread-anchor', { bubbles: true }));
        }
      };
      let frame = 0, previous = 0, rendered = 0, elapsed = 0;
      let visible = true, lost = false, shaderFailed = false;
      const setReady = (ready: boolean) => {
        gpuReadyRef.current = ready; setGpuReady(ready);
        host.dataset.gpuStatus = ready ? 'ready' : 'fallback';
        if (!ready) { anchorX = NaN; anchorY = NaN; if(motion.current.paused||motion.current.reduced){foldARef.current?.setAttribute('scale','0');foldBRef.current?.setAttribute('scale','0');pointerFoldRef.current?.setAttribute('scale','0')} const [x,y]=fallbackAnchorPoint(); anchorRef.current?.setAttribute('cx', String(x)); anchorRef.current?.setAttribute('cy', String(y)); host.dispatchEvent(new CustomEvent('memory-thread-anchor', { bubbles: true })); }
        wakeRef.current?.();
      };
      renderer.debug.checkShaderErrors = true;
      renderer.debug.onShaderError = () => { shaderFailed = true; setReady(false); host.dataset.gpuStatus = 'shader-error'; };
      const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
      const request = () => { if (!frame && !disposed && visible && !document.hidden && !lost && !shaderFailed) frame = requestAnimationFrame(draw); };
      function draw(now: number) {
        frame = 0;
        if (disposed || !visible || document.hidden || lost || shaderFailed) return;
        const active = !motion.current.paused && !motion.current.reduced;
        const delta = previous ? Math.min((now - previous) / 1000, .065) : 0;
        previous = now;
        if (active) elapsed += delta;
        if (now - rendered >= 1000 / (mobile ? 20 : 24) || !gpuReadyRef.current || !active) {
          rendered = now;
          // Slow the source's internal cross-section deformation, not the object transform.
          uniforms.uTime.value = elapsed * Math.PI * 2 / 12;
          const m = motion.current;
          if (active) { m.x += (m.targetX - m.x) * .12; m.y += (m.targetY - m.y) * .12; m.strength += (m.targetStrength - m.strength) * .075; }
          uniforms.uPointer.value.set(m.x - .5, .5 - m.y, m.strength);
          synchronizeCamera();
          renderer.render(scene, camera);
          if (!shaderFailed && !gpuReadyRef.current && renderer.info.render.calls > 0) setReady(true);
          if (!shaderFailed && gpuReadyRef.current) updateAnchor();
        }
        if (active) request();
      }
      const resize = () => {
        const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
        const resolutionCap = mobile ? 440 : 720;
        const scale = Math.min(1, resolutionCap / Math.max(width, height));
        renderer.setSize(Math.round(width * scale), Math.round(height * scale), false);
        const aspect = width / height;
        camera.left = -2.508 * Math.max(aspect, 1); camera.right = -camera.left;
        camera.top = 2.508 / Math.min(aspect, 1); camera.bottom = -camera.top;
        camera.updateProjectionMatrix(); synchronizeCamera(); request();
      };
      const visibility = () => { if (document.hidden) stop(); else request(); };
      const contextLost = (event: Event) => { event.preventDefault(); lost = true; stop(); setReady(false); };
      const contextRestored = () => { lost = false; shaderFailed = false; request(); };
      const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) request(); else stop(); }, { threshold: .02 });
      intersection.observe(host);
      const observer = new ResizeObserver(resize); observer.observe(host);
      document.addEventListener('visibilitychange', visibility);
      renderer.domElement.addEventListener('webglcontextlost', contextLost);
      renderer.domElement.addEventListener('webglcontextrestored', contextRestored);
      gpuWakeRef.current = () => { stop(); request(); };
      resize();
      release = () => {
        stop(); intersection.disconnect(); observer.disconnect();
        document.removeEventListener('visibilitychange', visibility);
        renderer.domElement.removeEventListener('webglcontextlost', contextLost);
        renderer.domElement.removeEventListener('webglcontextrestored', contextRestored);
        reference.dispose(); fibers.dispose(); redThread.dispose(); geometry.dispose(); material.dispose(); groundGeometry.dispose(); groundMaterial.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
        gpuWakeRef.current = null; gpuReadyRef.current = false;
      };
    }).catch(() => { release(); host.dataset.gpuStatus = 'setup-error'; gpuReadyRef.current = false; setGpuReady(false); wakeRef.current?.(); });
    return () => { disposed = true; release(); };
  }, []);

  const togglePause = () => {
    const next = !motion.current.paused;
    motion.current.paused = next;
    setPaused(next);
    wakeRef.current?.();
    gpuWakeRef.current?.();
  };

  return <div ref={hostRef} className={`${styles.scene} ${className}`} data-memory-body data-paused={paused} data-gpu-ready={gpuReady}>
    <svg className={styles.artwork} viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <filter id={filterId} x="-40" y="-40" width="1080" height="1080" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feImage ref={fieldARef} x="0" y="0" width="1000" height="1000" preserveAspectRatio="none" result="foldFieldA"/>
          <feDisplacementMap ref={foldARef} in="SourceGraphic" in2="foldFieldA" scale="0" xChannelSelector="R" yChannelSelector="G" result="foldA"/>
          <feImage ref={fieldBRef} x="0" y="0" width="1000" height="1000" preserveAspectRatio="none" result="foldFieldB"/>
          <feDisplacementMap ref={foldBRef} in="foldA" in2="foldFieldB" scale="0" xChannelSelector="R" yChannelSelector="G" result="breathingFibers"/>
          <feImage ref={pointerFieldRef} x="330" y="330" width="340" height="340" preserveAspectRatio="none" result="pointerField"/>
          <feFlood floodColor="#808080" result="neutralField"/>
          <feComposite in="pointerField" in2="neutralField" operator="over" result="localPointerField"/>
          <feDisplacementMap ref={pointerFoldRef} in="breathingFibers" in2="localPointerField" scale="0" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
      </defs>
      <image href={SCULPTURE_URL} x="0" y="0" width="1000" height="1000" preserveAspectRatio="xMidYMid meet" filter={`url(#${filterId})`} />
      <circle ref={anchorRef} cx="610" cy="755" r=".1" fill="transparent" pointerEvents="none" data-memory-thread-anchor />
    </svg>
    <div ref={gpuHostRef} className={styles.gpuViewport} aria-hidden="true" />
    <div className={styles.interaction} role="group" tabIndex={0}
      aria-label={zh ? '缓慢呼吸的记忆纤维。移动指针可轻触局部纤维。按 P 键暂停或继续。' : 'Slowly breathing memory fibers. Move the pointer to gently influence nearby fibers. Press P to pause or resume.'}
      onPointerMove={event => {
        if (motion.current.reduced || event.pointerType === 'touch') return;
        const bounds = event.currentTarget.getBoundingClientRect();
        motion.current.targetX = clamp((event.clientX - bounds.left) / bounds.width);
        motion.current.targetY = clamp((event.clientY - bounds.top) / bounds.height);
        motion.current.targetStrength = .75;
      }}
      onPointerLeave={() => { motion.current.targetStrength = 0; }}
      onKeyDown={event => { if (event.key.toLowerCase() === 'p' || event.key === ' ') { event.preventDefault(); togglePause(); } }}
    />
    <div className={styles.accessibilityControls}><button type="button" onClick={togglePause} aria-pressed={paused}>{paused ? (zh ? '继续呼吸动画' : 'Resume animation') : (zh ? '暂停呼吸动画' : 'Pause animation')}</button></div>
  </div>;
}
