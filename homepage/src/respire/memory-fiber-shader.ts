import { memoryBreathGLSL } from './memory-fiber-surface';

/**
 * Reference-traced, independently draped annular sheets and individual fibers.
 * The user-supplied GLSL remains the technical shader reference:
 * https://www.shadertoy.com/view/WlcfRn (user designated MIT; author not supplied).
 * The full supplied example is preserved in WlcfRn-user-supplied.glsl. Geometry
 * is redesigned around the supplied artwork, rather than its eight-cable demo.
 */
export const memoryFiberVertexShader = `
  uniform float uTime;
  uniform vec3 uPointer;
  varying vec3 vSurfacePosition;
  varying vec3 vSurfaceNormal;
  varying vec2 vSurfaceParam;
  varying float vSheetOcclusion;
  attribute vec3 surfaceParam;
  attribute vec3 calibratedColor;
  varying vec3 vCalibratedColor;
  varying vec2 vReferenceUv;
  ${memoryBreathGLSL}
  void main() {
    float angle=surfaceParam.x,s=surfaceParam.y;
    vec3 p=breathe(position,surfaceParam.xy);
    vec3 n=normal;
    vCalibratedColor=calibratedColor;
    vReferenceUv=position.xy/5.016+.5;
    vSurfacePosition=p;
    vSurfaceNormal=n;
    vSurfaceParam=vec2(angle,s);
    vSheetOcclusion=surfaceParam.z;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
  }
`;

/** Reference photography supplies fiber-scale albedo on actual draped 3D geometry.
 * It is projected in rest space, so detail follows each deforming sheet. The red
 * path is excluded in the shader and is rendered separately as a real tube. */
export const memoryReferenceMaterialGLSL = `
  uniform sampler2D uReference;
  float redAt(vec3 c){return smoothstep(.08,.18,c.r-c.g)*smoothstep(1.15,1.55,c.r/max(c.g,.01));}
  vec3 referenceAt(vec2 uv){
    vec3 c=texture2D(uReference,uv).rgb;
    float red=redAt(c);
    if(red>.01){
      vec3 sum=vec3(0.);float weight=0.;
      for(int i=0;i<8;i++){
        float a=float(i)*.785398;
        vec3 n=texture2D(uReference,uv+vec2(cos(a),sin(a))*.0064).rgb;
        float w=1.-redAt(n);sum+=n*w;weight+=w;
      }
      c=mix(c,sum/max(weight,.01),red);
    }
    return c;
  }
`;
export const memoryFiberFragmentShader = `
  varying vec3 vSurfaceNormal;
  varying vec2 vSurfaceParam;
  varying vec2 vReferenceUv;
  uniform vec3 uLightDirection;
  ${memoryReferenceMaterialGLSL}
  void main(){
    vec3 detail=referenceAt(vReferenceUv);
    float light=max(dot(normalize(vSurfaceNormal),normalize(uLightDirection)),0.);
    float paper=dot(detail,vec3(.2126,.7152,.0722));
    float alpha=1.-smoothstep(.86,.936,paper);
    // A photo ground shadow must not become a solid surface beneath the
    // lower-left curtain. This rest-space edge follows its reference silhouette.
    vec2 pixel=vec2(vReferenceUv.x,1.-vReferenceUv.y)*1254.;
    // Fiber-energy envelope sampled from the unchanged reference, in pixels.
    const float edgeY[21]=float[21](821.,869.,900.,920.,935.,947.,956.,964.,970.,983.,1008.,1033.,1053.,1070.,1086.,1102.,1112.,1116.,1119.,1119.,1118.);
    float column=clamp((pixel.x-130.)/25.,0.,19.999),t=fract(column);
    int j=int(floor(column));
    float a=edgeY[max(j-1,0)],b=edgeY[j],c=edgeY[min(j+1,20)],d=edgeY[min(j+2,20)];
    float edge=.5*(2.*b+(-a+c)*t+(2.*a-5.*b+4.*c-d)*t*t+(-a+3.*b-3.*c+d)*t*t*t);
    float skirt=(1.-smoothstep(570.,625.,pixel.x))*smoothstep(700.,790.,pixel.y);
    alpha*=mix(1.,1.-smoothstep(edge-2.,edge+5.,pixel.y),skirt);
    if(alpha<.03)discard;
    gl_FragColor=vec4(detail*(.985+.015*light),alpha);
    #include <colorspace_fragment>
  }
`;

/** Soft contact and cavity shadow, in the same frontal reference coordinate frame. */
export const memoryGroundVertexShader = `
  varying vec2 vGround;
  void main(){vGround=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}
`;
export const memoryGroundFragmentShader = `
  varying vec2 vGround;
  void main(){
    vec2 p=vGround;
    float contact=exp(-pow((p.x+.10)/1.58,2.)-pow((p.y+1.94)/.33,2.))*.46;
    float cavity=exp(-pow((p.x-.02)/.71,2.)-pow((p.y-.22)/.52,2.))*.64;
    gl_FragColor=vec4(.22,.20,.16,contact+cavity);
    #include <colorspace_fragment>
  }
`;
