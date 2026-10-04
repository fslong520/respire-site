export type ThreadPoint = {x:number;y:number};

/** Stable, low-amplitude variation: resizing never picks a new random thread. */
function irregularity(index:number) {
  let value=(0x72c4a1d3+Math.imul(index+1,0x6d2b79f5))|0;
  value=Math.imul(value^(value>>>15),value|1);
  value^=value+Math.imul(value^(value>>>7),value|61);
  return (((value^(value>>>14))>>>0)/4294967296)*2-1;
}

function between(a:ThreadPoint,b:ThreadPoint,t:number,offset:number):ThreadPoint {
  const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1;
  return {x:a.x+dx*t-dy/length*offset,y:a.y+dy*t+dx/length*offset};
}

/** A continuous soft spline, directly from the sculpture to Recall, then Store.
 * All control points are attached to measured layout coordinates. The fixed
 * variation produces a relaxed strand, with no moving rail or per-frame jitter.
 */
export function createNarrativeThread(anchor:ThreadPoint,recall:ThreadPoint,store:ThreadPoint) {
  const descent=Math.hypot(recall.x-anchor.x,recall.y-anchor.y);
  const sway=Math.min(42,Math.max(18,descent*.10));
  const row=Math.abs(store.y-recall.y)<35;
  const points:ThreadPoint[]=[anchor,
    between(anchor,recall,.24,sway*(.40+.12*irregularity(0))),
    between(anchor,recall,.53,sway*(-.60+.12*irregularity(1))),
    between(anchor,recall,.79,sway*(-.20+.08*irregularity(2))),
    recall,
    between(recall,store,row?.27:.20,row?-30:50),
    between(recall,store,.61,row?-12:43),
    between(recall,store,.83,row?5:22),
    store,
    {x:store.x+(row?31:-25),y:store.y+(row?8:17)},
    {x:store.x+(row?48:-38),y:store.y+(row?2:27)},
  ];
  const n=(value:number)=>Number(value.toFixed(2));
  const xy=(p:ThreadPoint)=>`${n(p.x)} ${n(p.y)}`;
  const segments:string[]=[];
  for(let i=0;i<points.length-1;i++) {
    const previous=points[Math.max(0,i-1)],a=points[i],b=points[i+1],next=points[Math.min(points.length-1,i+2)];
    const c1={x:a.x+(b.x-previous.x)/6,y:a.y+(b.y-previous.y)/6};
    const c2={x:b.x-(next.x-a.x)/6,y:b.y-(next.y-a.y)/6};
    segments.push(`C ${xy(c1)}, ${xy(c2)}, ${xy(b)}`);
  }
  const through=(count:number)=>`M ${xy(anchor)} ${segments.slice(0,count).join(' ')}`;
  return {path:through(segments.length),throughRecall:through(4),throughStore:through(8),points};
}
