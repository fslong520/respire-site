"use client";

import {useEffect, useRef, type ReactNode} from 'react';
import {createNarrativeThread} from './memory-narrative-path';

/** One continuous strand: the artwork becomes recalled context, then stored context. */
export default function MemoryNarrative({children}:{children:ReactNode}) {
  const hostRef=useRef<HTMLDivElement>(null);
  const svgRef=useRef<SVGSVGElement>(null);
  const pathRef=useRef<SVGPathElement>(null);
  const guideRef=useRef<SVGPathElement>(null);
  const tipRef=useRef<SVGCircleElement>(null);

  useEffect(()=>{
    const host=hostRef.current, svg=svgRef.current, path=pathRef.current, guide=guideRef.current, tip=tipRef.current;
    if(!host||!svg||!path||!guide||!tip)return;
    const preference=window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame=0, disposed=false;
    let geometry:{startY:number;endY:number;length:number;storeAt:number;recallAt:number}|null=null;
    const paint=()=>{
      frame=0;
      if(!geometry||disposed)return;
      const top=host.getBoundingClientRect().top+window.scrollY;
      const start=top+geometry.startY-window.innerHeight*.76;
      const end=top+geometry.endY-window.innerHeight*.48;
      const progress=preference.matches?1:Math.max(0,Math.min(1,(window.scrollY-start)/Math.max(180,end-start)));
      path.style.strokeDashoffset=String(1-progress);
      host.dataset.threadProgress=progress.toFixed(3);
      const p=path.getPointAtLength(geometry.length*progress);
      tip.setAttribute('cx',String(p.x));tip.setAttribute('cy',String(p.y));
      tip.style.opacity=progress>0&&progress<1?'1':'0';
      host.querySelector<HTMLElement>('[data-memory-store]')?.setAttribute('data-thread-reached',String(progress>=geometry.storeAt));
      host.querySelector<HTMLElement>('[data-memory-recall]')?.setAttribute('data-thread-reached',String(progress>=geometry.recallAt));
    };
    const requestPaint=()=>{if(!frame)frame=requestAnimationFrame(paint)};
    const measure=()=>{
      const anchor=host.querySelector<HTMLElement>('[data-memory-thread-anchor]');
      const store=host.querySelector<HTMLElement>('[data-memory-store] .loop-node');
      const recall=host.querySelector<HTMLElement>('[data-memory-recall] .loop-node');
      if(!anchor||!store||!recall)return;
      const box=host.getBoundingClientRect();
      const point=(el:HTMLElement)=>{const r=el.getBoundingClientRect();return{x:r.left-box.left+r.width/2,y:r.top-box.top+r.height/2}};
      const a=point(anchor), s=point(store), r=point(recall);
      const strand=createNarrativeThread(a,r,s);
      svg.setAttribute('viewBox',`0 0 ${box.width} ${box.height}`);
      guide.setAttribute('d',strand.throughRecall);const recallLength=guide.getTotalLength();
      guide.setAttribute('d',strand.throughStore);const storeLength=guide.getTotalLength();
      path.setAttribute('d',strand.path);guide.setAttribute('d',strand.path);
      const length=path.getTotalLength();
      geometry={startY:a.y,endY:Math.max(s.y,r.y)+32,length,storeAt:storeLength/length,recallAt:recallLength/length};
      requestPaint();
    };
    const resize=new ResizeObserver(measure);resize.observe(host);
    const art=host.querySelector('[data-memory-thread-anchor]');if(art)resize.observe(art);
    host.querySelectorAll('[data-memory-recall],[data-memory-store],.memory-loop-intro').forEach(element=>resize.observe(element));
    window.addEventListener('scroll',requestPaint,{passive:true});
    window.addEventListener('resize',measure);
    host.addEventListener('memory-thread-anchor',measure);
    preference.addEventListener('change',requestPaint);
    void document.fonts.ready.then(()=>{if(!disposed)measure()});
    measure();
    return()=>{disposed=true;cancelAnimationFrame(frame);resize.disconnect();window.removeEventListener('scroll',requestPaint);window.removeEventListener('resize',measure);host.removeEventListener('memory-thread-anchor',measure);preference.removeEventListener('change',requestPaint)};
  },[]);

  return <div ref={hostRef} className="memory-narrative">
    <svg ref={svgRef} className="narrative-strand" aria-hidden="true" preserveAspectRatio="none">
      <path ref={guideRef} className="narrative-strand-guide" fill="none"/>
      <path ref={pathRef} className="narrative-strand-ink" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset="1"/>
      <circle ref={tipRef} className="narrative-strand-tip" r="2.3" opacity="0"/>
    </svg>
    {children}
  </div>;
}
