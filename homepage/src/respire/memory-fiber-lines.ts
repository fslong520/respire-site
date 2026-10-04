import {referenceFilamentPaths} from './memory-fiber-traces';
import {memoryReferenceMaterialGLSL} from './memory-fiber-shader';
import {calibratedLightAt} from './memory-fiber-calibration';
import type * as Three from 'three';
import {memoryBreathGLSL, sheetPointAt} from './memory-fiber-surface';

type FiberUniforms = {
  uTime: {value:number};
  uReference?: {value:Three.Texture};
  uPointer: {value:Three.Vector3};
  uLightDirection: {value:Three.Vector3};
};

/** Separated hairlines follow independently folded annular sheets. */
export const memoryFiberLineVertexShader = `
  uniform float uTime;
  uniform vec3 uPointer;
  uniform vec3 uLightDirection;
  attribute float side;
  attribute float strandEnd;
  varying float vEdge;
  varying vec3 vFiberColor;
  varying float vFiberOpacity;
  varying float vOcclusion;
  varying vec2 vReferenceUv;
  attribute vec3 surfaceParam;
  attribute vec3 calibratedColor;
  ${memoryBreathGLSL}
  void main() {
    float theta=surfaceParam.x,s=surfaceParam.y,seed=surfaceParam.z;
    vec3 p=breathe(position,surfaceParam.xy);
    float occlusion=step(3.5,seed),rim=step(1.5,seed)*(1.-occlusion);
    p.xy+=normal.xy*sin(uTime)*(.012*occlusion-.003*rim);
    vOcclusion=occlusion;
    vReferenceUv=position.xy/5.016+.5;
    float light=max(0.,dot(normal,normalize(uLightDirection)));
    float roof=pow(max(sin(theta),0.),2.)*(1.-smoothstep(.02,.32,s));
    float leftGutter=pow(max(-cos(theta),0.),3.)*(1.-smoothstep(.10,.42,s));
    float shade=mix(.54,1.,sqrt(light))*mix(1.,.51,roof)*mix(1.,.56,leftGutter);
    float variation=.86+.14*fract(seed*31.17);
    float frontRidge=exp(-pow((p.x+.32)/.34,2.)-pow((p.y+.46)/.37,2.));
    float darkFiber=1.-smoothstep(.06,.20,dot(calibratedColor,vec3(.2126,.7152,.0722)));
    vFiberColor=(calibratedColor*(1.82+frontRidge*.10)+vec3(.075)*darkFiber)*(.93+.07*light)*(.94+.06*variation)*mix(1.,.88,smoothstep(.52,.86,s));
    float foldGap=exp(-pow((s-.55-.05*sin(theta*2.))/.045,2.));
    float rolledEdge=step(1.5,seed)*(1.-occlusion);
    vFiberColor=mix(vFiberColor,vec3(.96,.88,.76),rolledEdge*(.53+.17*light));
    vFiberOpacity=mix(mix(.93,1.,fract(seed*17.3)),.48,occlusion)*strandEnd*(1.-.15*foldGap);
    vEdge=side;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
  }
`;

export const memoryFiberLineFragmentShader = `
  varying float vEdge;
  varying vec3 vFiberColor;
  varying float vFiberOpacity;
  varying float vOcclusion;
  varying vec2 vReferenceUv;
  ${memoryReferenceMaterialGLSL}
  void main(){
    float coverage=1.-smoothstep(1.-max(fwidth(vEdge),.12),1.,abs(vEdge));
    float roundness=sqrt(max(0.,1.-vEdge*vEdge));
    vec3 detail=referenceAt(vReferenceUv);
    gl_FragColor=vec4(detail*(.78+.22*roundness),vFiberOpacity*coverage*.72);
    #include <colorspace_fragment>
  }
`;

/** Real reference-direction filaments lifted onto the modeled 3D relief. */
export function createMemoryFiberRibbonData(mobile:boolean) {
  // Keep a small set of actual strand trajectories at folded and outer edges.
  // The reference-projected material carries subordinate fiber detail.
  const paths=referenceFilamentPaths(mobile).filter(path=>path[0][5]<463).map(path=>({path,length:path.reduce((a,p,i)=>a+(i?Math.hypot(p[0]-path[i-1][0],p[1]-path[i-1][1]):0),0)})).sort((a,b)=>b.length-a.length).slice(0,mobile?64:80).map(entry=>entry.path);
  // A few softly lit rolled edges organize the finer, quieter fibers into sheets.
  const lips=[
    [[293,450],[235,474],[212,513],[243,552],[288,576],[316,625],[338,678],[399,704],[473,710],[504,749],[509,805],[524,868],[568,905],[652,927],[751,948],[835,922],[883,852],[915,779],[984,729],[1085,704]],
    [[306,444],[402,426],[475,402],[523,342],[561,275],[625,228],[692,255],[756,298],[836,307],[887,345],[907,401],[911,465],[949,530],[1043,583]],
    [[357,741],[356,781],[370,830],[398,883],[443,934],[505,976],[577,1002],[648,1002],[715,986]],
  ];
  lips.forEach((controls,lipIndex)=>{
    const curve:number[][]=[];
    for(let i=0;i<controls.length-1;i++)for(let j=0;j<16;j++){
      const t=j/16,a=controls[Math.max(0,i-1)],b=controls[i],c=controls[i+1],d=controls[Math.min(controls.length-1,i+2)];
      const xy=[0,1].map(axis=>.5*(2*b[axis]+(-a[axis]+c[axis])*t+(2*a[axis]-5*b[axis]+4*c[axis]-d[axis])*t*t+(-a[axis]+3*b[axis]-3*c[axis]+d[axis])*t*t*t));
      const x=(xy[0]-627)/250,y=(627-xy[1])/250;
      curve.push([x,y,1.45+.05*Math.sin(i*.4),Math.atan2(y,x),.35,-1,lipIndex===1?-1:1]);
    }
    paths.push(curve.map(p=>[...p.slice(0,5),-2,p[6]]),curve);
  });
  const positions:number[]=[],normals:number[]=[],params:number[]=[],colors:number[]=[],ends:number[]=[],sides:number[]=[],indices:number[]=[];
  paths.forEach((path,pathIndex)=>{
    const originalIndex=path[0][5];
    const center=path.reduce((sum,p)=>[sum[0]+p[0]/path.length,sum[1]+p[1]/path.length,sum[2]+p[4]/path.length],[0,0,0]);
    // Keep the continuous structural folds, but let the outer curtain breathe.
    // Supplemental paths are reserved for the front lip and deeper inner folds.
    if(originalIndex>=463) {
      const front=center[1]<-.30&&Math.hypot(center[0],center[1])<1.65;
      const inner=center[2]<.46;
      if(!front&&!inner&&originalIndex%2!==0)return;
    }
    const neighbors=[0];
    for(const neighbor of neighbors){
      const rolledEdge=originalIndex===-1,occlusionEdge=originalIndex===-2;
      const offset=positions.length/3,seed=(pathIndex*.61803398875+neighbor*.1+1)%1+(rolledEdge?2:occlusionEdge?4:0);
      for(let i=0;i<path.length;i++){
        const p=path[i],prev=path[Math.max(0,i-1)],next=path[Math.min(path.length-1,i+1)];
        const dx=next[0]-prev[0],dy=next[1]-prev[1],length=Math.hypot(dx,dy)||1;
        const nx=-dy/length,ny=dx/length;
        const spread=neighbor/250*(.85+.15*Math.sin(i*.04+seed*6))+(occlusionEdge?p[6]*.016:0);
        const x=p[0]+nx*spread,y=p[1]+ny*spread;
        // The small rolled left lip sits in front of the supporting sheet.
        const rolledLip=.42*Math.exp(-(((x+1.72)/.13)**2)-((y-.46)/.19)**2);
        const z=p[2]+.003*seed+rolledLip+(mobile ? .10 : 0);
        const theta=p[3],s=p[4];
        const color=calibratedLightAt([x,y]);
        const taper=originalIndex<0?22:path.length<100?5:9;
        const end=Math.min(1,i/taper,(path.length-1-i)/taper);
        for(const side of [-1,1]){
          const width=occlusionEdge?.011:rolledEdge?.0055:(mobile ? .0050 : .0038);
          positions.push(x+nx*side*width,y+ny*side*width,z);
          normals.push(...(originalIndex<0?[nx*p[6],ny*p[6],0]:[-.1,.24,.966]));params.push(theta,s,seed);colors.push(...color);ends.push(end);sides.push(side);
        }
      }
      for(let i=0;i<path.length-1;i++){const a=offset+i*2;indices.push(a,a+1,a+2,a+2,a+1,a+3)}
    }
  });
  return {positions:new Float32Array(positions),normals:new Float32Array(normals),params:new Float32Array(params),colors:new Float32Array(colors),ends:new Float32Array(ends),side:new Float32Array(sides),indices:new Uint32Array(indices)};
}

export function createMemoryFiberLines(THREE:typeof import('three'),uniforms:FiberUniforms,mobile:boolean) {
  const data=createMemoryFiberRibbonData(mobile),geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(data.positions,3));
  geometry.setAttribute('normal',new THREE.BufferAttribute(data.normals,3));
  geometry.setAttribute('surfaceParam',new THREE.BufferAttribute(data.params,3));
  geometry.setAttribute('calibratedColor',new THREE.BufferAttribute(data.colors,3));
  geometry.setAttribute('side',new THREE.BufferAttribute(data.side,1));
  geometry.setAttribute('strandEnd',new THREE.BufferAttribute(data.ends,1));
  geometry.setIndex(new THREE.BufferAttribute(data.indices,1));
  const material=new THREE.ShaderMaterial({
    name:'Respire individually folded hairline sheets',uniforms,
    vertexShader:memoryFiberLineVertexShader,fragmentShader:memoryFiberLineFragmentShader,
    transparent:true,depthTest:true,depthWrite:false,side:THREE.DoubleSide,forceSinglePass:true,
  });
  const object=new THREE.Mesh(geometry,material);
  object.frustumCulled=false;object.renderOrder=2;
  return {object,dispose:()=>{geometry.dispose();material.dispose()}};
}

/** One thin sculptural line loops beyond the right-hand silhouette. */
export function createMemoryRedThread(THREE:typeof import('three')) {
  // Screen-calibrated controls are genuine world-space geometry, with variable
  // depth allowing the strand to disappear naturally behind draped layers.
  const pixels=[
    [938,488,1.02],[990,442,1.02],[1050,447,1.02],[1132,477,1.02],
    [1193,543,1.02],[1208,598,1.02],[1187,652,1.02],[1138,688,1.02],
    [1050,707,1.02],[953,735,1.02],[904,802,1.02],[866,883,1.02],
    [802,939,1.02],[721,948,1.02],[640,929,1.02],[568,908,1.02],
    [525,872,1.02],[509,816,1.02],[514,774,1.02],[493,739,1.02],
    [437,710,1.02],[367,690,1.02],[330,666,1.02],[312,614,1.02],
    [283,575,1.02],[238,550,1.02],[212,515,1.02],[228,482,1.02],
    [293,450,.8],[350,445,-.7],[478,380,-.7],[548,310,-.7],
    [595,260,-.7],[643,231,-.7],[705,280,-.7],[768,307,-.7],
    [825,310,-.7],[868,350,-.7],[998,608,-.7],[912,915,-.7],[670,1051,-.7],
    [410,966,-.7],[250,850,-.7],[180,739,-.7],[146,680,-.7],[117,638,-.7],[98,631,.95],[85,679,1.05],
    [112,705,1.05],[172,706,1.05],[242,675,1.05],[307,641,1.05],
    [354,625,1.05],[400,626,1.05],[452,614,1.05],[483,626,1.05],
    [521,656,1.05],[580,675,1.05],[608,710,1.05],[635,765,1.05],
    [683,798,1.05],[754,800,.02],[812,853,-.7],[905,819,-.7],[995,690,-.7],[972,530,-.7],
    [917,538,-.7],[930,498,.7],
  ];
  const points=pixels.map(([x,y,z])=>new THREE.Vector3((x-627)/250,(627-y)/250,z));
  const curve=new THREE.CatmullRomCurve3(points,true,'centripetal');
  const pointAt=(angle:number)=>curve.getPoint(((angle/(Math.PI*2))%1+1)%1);
  const geometry=new THREE.TubeGeometry(curve,1400,.0050,8,true);
  const material=new THREE.ShaderMaterial({
    name:'Fine vermilion filament with concealed return',transparent:true,depthTest:true,depthWrite:true,
    uniforms:{uColor:{value:new THREE.Color('#b34725')}},
    vertexShader:`varying float vVisibility; void main(){vVisibility=smoothstep(.12,.85,position.z);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`uniform vec3 uColor;varying float vVisibility;void main(){if(vVisibility<.01)discard;gl_FragColor=vec4(uColor,vVisibility);
#include <colorspace_fragment>
}`,
  });
  const object=new THREE.Mesh(geometry,material);
  object.name='One continuous vermilion memory thread';object.renderOrder=3;
  return {object,pointAt,dispose:()=>{geometry.dispose();material.dispose()}};
}

// Retain the CPU map in this module's public dependency graph for geometry QA.
export {sheetPointAt};
