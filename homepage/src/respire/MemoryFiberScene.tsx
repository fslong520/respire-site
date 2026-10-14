import {SCULPTURE_URL} from '../destinations';
"use client";

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import styles from './MemoryFiberScene.module.css';

export interface MemoryFiberSceneProps { className?: string; locale?: 'en' | 'zh'; layerHost?: RefObject<HTMLDivElement | null> }

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
export default function MemoryFiberScene({ className = '', locale = 'en', layerHost }: MemoryFiberSceneProps) {
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
    const layer = layerHost?.current ?? host;
    let disposed = false;
    let release = () => {};
    const setReady = (ready: boolean) => {
      gpuReadyRef.current = ready; setGpuReady(ready);
      host.dataset.gpuStatus = ready ? 'ready' : 'fallback';
      if (!ready) {
        if (motion.current.paused || motion.current.reduced) {
          foldARef.current?.setAttribute('scale', '0');
          foldBRef.current?.setAttribute('scale', '0');
          pointerFoldRef.current?.setAttribute('scale', '0');
        }
        const [x, y] = fallbackAnchorPoint();
        anchorRef.current?.setAttribute('cx', String(x));
        anchorRef.current?.setAttribute('cy', String(y));
        host.dispatchEvent(new CustomEvent('memory-thread-anchor', { bubbles: true }));
      }
      wakeRef.current?.();
    };
    void import('three').then(async (THREE) => {
      if (disposed) return;
      host.dataset.gpuStatus = 'loading';
      const { startMemoryPointCloud } = await import('./memory-point-cloud');
      const created = await startMemoryPointCloud(THREE, layer, {
        heroBox: () => hostRef.current?.getBoundingClientRect() ?? layer.getBoundingClientRect(),
        onReadyChange: setReady,
        onAnchor: (x, y) => {
          anchorRef.current?.setAttribute('cx', x.toFixed(2));
          anchorRef.current?.setAttribute('cy', y.toFixed(2));
          host.dispatchEvent(new CustomEvent('memory-thread-anchor', { bubbles: true }));
        },
        onUnavailable: () => { host.dataset.gpuStatus = 'unavailable'; },
        onSetupError: () => { host.dataset.gpuStatus = 'setup-error'; gpuReadyRef.current = false; setGpuReady(false); wakeRef.current?.(); },
      });
      if (disposed) { created?.dispose(); return; }
      if (!created) return;
      release = () => { created.dispose(); gpuWakeRef.current = null; gpuReadyRef.current = false; };
      gpuWakeRef.current = () => { created.setReduced(motion.current.reduced); created.setPaused(motion.current.paused); created.wake(); };
      created.setReduced(motion.current.reduced);
      created.setPaused(motion.current.paused);
      created.wake();
    }).catch(() => {
      release();
      host.dataset.gpuStatus = 'setup-error';
      gpuReadyRef.current = false; setGpuReady(false); wakeRef.current?.();
    });
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
