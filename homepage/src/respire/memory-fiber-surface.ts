import {calibratedLightAt} from './memory-fiber-calibration';
/**
 * Camera-facing 3D annular sheets calibrated to the user's 1254px reference.
 * Each row follows a different draped contour, not a twisted torus section.
 * Geometry, individual fibers, normals and animation share this exact map.
 */
export const MEMORY_SHEET_BANDS = 6;
const contourProfiles = [[[855, 646], [823, 558], [810, 499], [718, 504], [635, 476], [584, 494], [537, 547], [466, 572], [440, 635], [512, 668], [570, 683], [611, 724], [667, 787], [744, 774], [785, 719], [827, 690]], [[926, 651], [866, 546], [855, 434], [726, 386], [624, 350], [580, 365], [538, 438], [397, 516], [354, 604], [365, 667], [472, 705], [552, 767], [629, 855], [749, 853], [823, 802], [889, 732]], [[958, 679], [910, 515], [899, 365], [760, 310], [631, 231], [553, 281], [507, 384], [388, 441], [221, 501], [309, 595], [321, 673], [500, 745], [562, 881], [727, 938], [857, 893], [909, 773]], [[1060, 643], [963, 498], [922, 327], [791, 293], [652, 195], [545, 225], [473, 330], [369, 390], [150, 469], [211, 632], [295, 780], [431, 909], [581, 1021], [773, 991], [950, 883], [1016, 753]], [[1130, 647], [1058, 487], [983, 323], [825, 254], [642, 146], [497, 186], [424, 300], [290, 354], [104, 508], [151, 714], [260, 873], [436, 987], [600, 1080], [797, 1020], [987, 908], [1090, 782]], [[1180, 633], [1121, 435], [960, 279], [805, 224], [627, 113], [456, 179], [311, 317], [169, 408], [81, 554], [132, 754], [238, 946], [443, 1056], [611, 1108], [816, 1041], [981, 940], [1128, 807]]] as const;
const TAU = Math.PI * 2;
const clamp = (value:number,low=0,high=1)=>Math.max(low,Math.min(high,value));
function contourAt(profile:number,theta:number) {
  const scaled=((theta/TAU)%1+1)%1*16,index=Math.floor(scaled),t=scaled-index;
  const p=contourProfiles[profile];
  return [0,1].map(axis=>{
    const a=p[(index+15)%16][axis],b=p[index][axis],c=p[(index+1)%16][axis],d=p[(index+2)%16][axis];
    return .5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t);
  });
}
export function sheetPointAt(theta:number,layer:number,lift=0,time=0):[number,number,number] {
  const s=clamp(layer),k=s*5,index=Math.min(4,Math.floor(k)),t=k-index;
  const a=contourAt(Math.max(0,index-1),theta),b=contourAt(index,theta),c=contourAt(index+1,theta),d=contourAt(Math.min(5,index+2),theta);
  const pixel=[0,1].map(axis=>.5*(2*b[axis]+(-a[axis]+c[axis])*t+(2*a[axis]-5*b[axis]+4*c[axis]-d[axis])*t*t+(-a[axis]+3*b[axis]-3*c[axis]+d[axis])*t*t*t));
  let x=(pixel[0]-627)/250,y=(627-pixel[1])/250;
  const ridge=.19*Math.sin(s*Math.PI*5+.6*Math.sin(theta*2))+.16*Math.cos(s*Math.PI*8+.85*Math.sin(theta+1));
  const lower=Math.max(-Math.sin(theta),0),left=Math.max(-Math.cos(theta),0);
  const forward=.46*Math.exp(-(((s-.28)/.15)**2))*lower*lower;
  const curtain=.19*Math.exp(-(((s-.49)/.2)**2))*left*left*left;
  const curl=.32*Math.sin(s*Math.PI*6+.8*Math.sin(theta*2))*((.5+.5*Math.cos(theta-3.9))**6)*Math.sin(s*Math.PI);
  x+=Math.cos(theta)*curl;
  y+=Math.sin(theta)*curl;
  const raisedLip=.23*Math.exp(-(((s-.2)/.055)**2))*Math.max(0,Math.sin(theta*.9-.3));
  x+=.18*Math.exp(-(((theta-3.35)/.17)**2))*Math.pow(s,3);
  const z=raisedLip+.06+.22*Math.sin(s*Math.PI)-.38*(1-s)*Math.sin(theta)+ridge+forward+curtain+lift;
  const breath=Math.sin(time+.35*Math.sin(theta)+s*2.4);
  return [x+.012*breath*Math.cos(theta),y+.022*breath*Math.sin(theta),z+.024*Math.sin(time+.5*Math.sin(theta)+s*2)];
}

export function sheetNormalAt(theta:number,s:number):[number,number,number] {
  const a=sheetPointAt(theta-.001,s),b=sheetPointAt(theta+.001,s);
  const c=sheetPointAt(theta,Math.max(.00001,s-.0006)),d=sheetPointAt(theta,Math.min(.99999,s+.0006));
  const u=b.map((v,i)=>v-a[i]),v=d.map((n,i)=>n-c[i]);
  const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  const norm=Math.hypot(...n)*(n[2]<0?-1:1)||1;
  return [n[0]/norm,n[1]/norm,n[2]/norm];
}

/** The static sculpture is baked once. Only coherent, phase-lagged fold motion is evaluated per frame. */
export const memoryBreathGLSL=`
  vec3 breathe(vec3 p,vec2 param) {
    float theta=atan(p.y,p.x),s=clamp((length(p.xy)-.62)/1.65,0.,1.);
    float pointerMask=exp(-length(p.xy-uPointer.xy*5.)*3.);
    float phase=uTime+uPointer.z*.06*pointerMask;
    // Four broad, smooth fold fields unfold at different phases. They preserve
    // local strand coherence while leaving the silhouette broadly anchored.
    float top=exp(-pow(p.x/.95,2.)-pow((p.y-1.0)/.72,2.));
    float left=exp(-pow((p.x+1.0)/.63,2.)-pow((p.y-.1)/.84,2.));
    float front=exp(-pow((p.x-.02)/.83,2.)-pow((p.y+.80)/.63,2.));
    float right=exp(-pow((p.x-1.25)/.65,2.)-pow((p.y+.02)/.95,2.));
    float a=sin(phase);
    float b=sin(phase-.60)-sin(-.60);
    float c=sin(phase+2.7)-sin(2.7);
    float d=sin(phase+3.50)-sin(3.50);
    p.xy+=top*vec2(.010,.073)*a+left*vec2(-.068,.022)*b+front*vec2(.027,-.084)*c+right*vec2(.070,.025)*d;
    p.z+=.12*(top*a-left*b+front*c-right*d);
    return p;
  }
`;
export function createMemorySurfaceData(mobile:boolean) {
  const around=mobile?240:400,across=mobile?20:32;
  const positions:number[]=[],normals:number[]=[],params:number[]=[],colors:number[]=[],indices:number[]=[];
  for(let band=0;band<MEMORY_SHEET_BANDS;band++) {
    const offset=positions.length/3;
    for(let row=0;row<=across;row++) {
      const s=(band+(row/across))/MEMORY_SHEET_BANDS;
      for(let column=0;column<=around;column++) {
        const theta=column/around*TAU;
        const point=sheetPointAt(theta,s);positions.push(...point);colors.push(...calibratedLightAt(point));normals.push(...sheetNormalAt(theta,s));const p=sheetPointAt(theta,s),lip=Math.max(sheetPointAt(theta,Math.max(0,s-.018))[2],sheetPointAt(theta,Math.min(1,s+.018))[2]);params.push(theta,s,1-clamp((lip-p[2]-.018)*1.7,0,.5));
      }
    }
    for(let row=0;row<across;row++)for(let column=0;column<around;column++) {
      const a=offset+row*(around+1)+column,b=a+around+1;
      indices.push(a,b,a+1,a+1,b,b+1);
    }
  }
  return {positions:new Float32Array(positions),normals:new Float32Array(normals),params:new Float32Array(params),colors:new Float32Array(colors),indices:new Uint32Array(indices)};
}
