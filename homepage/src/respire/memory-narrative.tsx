"use client";

import {useEffect, useRef, type ReactNode} from 'react';
import {createNarrativeThread} from './memory-narrative-path';

const ANCHOR_TOLERANCE=8;

/** The strand is drawn by the page-wide WebGL layer; this shell only measures
 * the scroll spline to publish thread progress and light the Recall/Store dots.
 */
export default function MemoryNarrative({children}:{children:ReactNode}) {
  const hostRef=useRef<HTMLDivElement>(null);
  const svgRef=useRef<SVGSVGElement>(null);
  const guideRef=useRef<SVGPathElement>(null);

  useEffect(()=>{
    const host=hostRef.current, svg=svgRef.current, guide=guideRef.current;
    if(!host||!svg||!guide)return;
    const preference=window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame=0, disposed=false;
    let progress=0;
    let geometry:{startY:number;endY:number;length:number;storeAt:number;recallAt:number}|null=null;
    let anchorX=NaN, anchorY=NaN;
    const paint=()=>{
      frame=0;
      if(!geometry||disposed)return;
      const top=host.getBoundingClientRect().top+window.scrollY;
      const start=top+geometry.startY-window.innerHeight*.76;
      const end=top+geometry.endY-window.innerHeight*.48;
      progress=preference.matches?1:Math.max(0,Math.min(1,(window.scrollY-start)/Math.max(180,end-start)));
      host.dataset.threadProgress=progress.toFixed(3);
      host.querySelector<HTMLElement>('[data-memory-store]')?.setAttribute('data-thread-reached',String(progress>=geometry.storeAt));
      host.querySelector<HTMLElement>('[data-memory-recall]')?.setAttribute('data-thread-reached',String(progress>=geometry.recallAt));
    };
    const requestPaint=()=>{if(!frame)frame=requestAnimationFrame(paint)};
    const measure=(force=false)=>{
      const anchor=host.querySelector<HTMLElement>('[data-memory-thread-anchor]');
      const store=host.querySelector<HTMLElement>('[data-memory-store] .loop-node');
      const recall=host.querySelector<HTMLElement>('[data-memory-recall] .loop-node');
      if(!anchor||!store||!recall)return;
      const box=host.getBoundingClientRect();
      const point=(el:HTMLElement)=>{const r=el.getBoundingClientRect();return{x:r.left-box.left+r.width/2,y:r.top-box.top+r.height/2}};
      const a=point(anchor), s=point(store), r=point(recall);
      if(!force&&Math.abs(a.x-anchorX)<=ANCHOR_TOLERANCE&&Math.abs(a.y-anchorY)<=ANCHOR_TOLERANCE){requestPaint();return;}
      anchorX=a.x;anchorY=a.y;
      const strand=createNarrativeThread(a,r,s);
      svg.setAttribute('viewBox',`0 0 ${box.width} ${box.height}`);
      guide.setAttribute('d',strand.throughRecall);const recallLength=guide.getTotalLength();
      guide.setAttribute('d',strand.throughStore);const storeLength=guide.getTotalLength();
      guide.setAttribute('d',strand.path);
      const length=guide.getTotalLength();
      geometry={startY:a.y,endY:Math.max(s.y,r.y)+32,length:length>0?length:1,storeAt:length>0?storeLength/length:0,recallAt:length>0?recallLength/length:0};
      requestPaint();
    };
    const onResize=()=>measure(true);
    const onAnchor=()=>measure(false);
    const resize=new ResizeObserver(onResize);resize.observe(host);
    const art=host.querySelector('[data-memory-thread-anchor]');if(art)resize.observe(art);
    host.querySelectorAll('[data-memory-recall],[data-memory-store],.memory-loop-intro').forEach(element=>resize.observe(element));
    window.addEventListener('scroll',requestPaint,{passive:true});
    window.addEventListener('resize',onResize);
    host.addEventListener('memory-thread-anchor',onAnchor);
    preference.addEventListener('change',requestPaint);
    void document.fonts.ready.then(()=>{if(!disposed)measure(true)});
    measure(true);
    return()=>{disposed=true;cancelAnimationFrame(frame);resize.disconnect();window.removeEventListener('scroll',requestPaint);window.removeEventListener('resize',onResize);host.removeEventListener('memory-thread-anchor',onAnchor);preference.removeEventListener('change',requestPaint)};
  },[]);

  return <div ref={hostRef} className="memory-narrative">
    <svg ref={svgRef} className="narrative-strand" aria-hidden="true" preserveAspectRatio="none">
      <path ref={guideRef} className="narrative-strand-guide" fill="none"/>
    </svg>
    {children}
  </div>;
}
